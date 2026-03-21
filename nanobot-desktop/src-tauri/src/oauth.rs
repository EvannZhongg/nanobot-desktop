use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};
use reqwest::Client;
use tauri::AppHandle;
use crate::emit_log;

use sha2::{Sha256, Digest};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthTokenPayload {
    pub access: String,
    pub refresh: String,
    pub expires: u64,
    pub account_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceOAuthInitPayload {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    pub interval: u64,
    pub verifier: String,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum DeviceTokenResult {
    Success { token: OAuthTokenPayload },
    Pending { slow_down: bool },
    Error { message: String },
}

fn pkce_challenge(verifier: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(hasher.finalize())
}

fn random_string() -> String {
    let bytes: [u8; 32] = rand::random();
    URL_SAFE_NO_PAD.encode(bytes)
}

#[tauri::command]
pub async fn start_browser_oauth(app: AppHandle, provider: String) -> Result<OAuthTokenPayload, String> {
    emit_log(&app, "gateway", format!("Starting browser OAuth for provider: {}", provider), "stdout");
    if provider != "openai" {
        return Err(format!("Unsupported browser OAuth provider: {}", provider));
    }
    
    let client_id = "app_EMoamEEZ73f0CkXaXp7hrann";
    let redirect_uri = "http://localhost:1455/auth/callback";
    let authorize_url = "https://auth.openai.com/oauth/authorize";
    let token_url = "https://auth.openai.com/oauth/token";
    
    let verifier = random_string();
    let challenge = pkce_challenge(&verifier);
    let state = random_string();
    
    let mut url = url::Url::parse(authorize_url).unwrap();
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("scope", "openid profile email offline_access")
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &state)
        .append_pair("id_token_add_organizations", "true")
        .append_pair("codex_cli_simplified_flow", "true")
        .append_pair("originator", "codex_cli_rs");
        
    let auth_url = url.to_string();
    
    // Start local server; handle port conflict gracefully.
    let server_addr = "127.0.0.1:1455";
    let server = tiny_http::Server::http(server_addr)
        .map_err(|e| format!("Failed to start callback server on {}: {}. Is another instance running?", server_addr, e))?;
        
    // Open browser
    emit_log(&app, "gateway", format!("Opening browser with URL: {}", auth_url), "stdout");
    if let Err(e) = open::that(&auth_url) {
        return Err(format!("Could not open browser: {}. Please go to this URL manually: {}", e, auth_url));
    }
    
    let mut obtained_code = None;
    let mut obtained_state = None;
    
    // Wait for callback (timeout after 5 minutes)
    for _ in 0..600 {
        if let Ok(Some(request)) = server.recv_timeout(std::time::Duration::from_millis(500)) {
            let req_url = request.url().to_string();
            // Match exactly or with trailing slash
            if req_url.starts_with("/auth/callback") {
                if let Ok(parsed) = url::Url::parse(&format!("http://localhost{}", req_url)) {
                    let mut code = None;
                    let mut st = None;
                    for (k, v) in parsed.query_pairs() {
                        if k == "code" { code = Some(v.clone().into_owned()); }
                        if k == "state" { st = Some(v.into_owned()); }
                    }
                    if let Some(c) = code {
                        obtained_code = Some(c);
                        obtained_state = st;
                        let response = tiny_http::Response::from_string(
                            "<!doctype html><html><head><meta charset=\"utf-8\"><title>Auth Success</title><style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f8fafc;} .card{background:white;padding:32px;border-radius:12px;box-shadow:0 4px 6px -1px rgb(0 0 0 / 0.1);text-align:center;max-width:400px;}</style></head><body><div class='card'><h2>Success</h2><p>Authentication complete. You can close this window now.</p><script>window.close();</script></div></body></html>"
                        ).with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..]).unwrap());
                        let _ = request.respond(response);
                        break;
                    } 
                }
            }
            let _ = request.respond(tiny_http::Response::from_string("Not Found").with_status_code(404));
        }
    }
    
    let code = obtained_code.ok_or_else(|| "OAuth callback timed out. Please try again.".to_string())?;
    
    if obtained_state.unwrap_or_default() != state {
        return Err("Security error: OAuth state mismatch. Possible forgery attempt.".to_string());
    }
    
    // Exchange token
    let client = Client::new();
    let params = [
        ("grant_type", "authorization_code"),
        ("client_id", client_id),
        ("code", &code),
        ("code_verifier", &verifier),
        ("redirect_uri", redirect_uri),
    ];
    
    let res = client.post(token_url)
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("Network error during token exchange: {}", e))?;
        
    if !res.status().is_success() {
        let text = res.text().await.unwrap_or_default();
        return Err(format!("OpenAI returned an error: {}", text));
    }
    
    #[derive(Deserialize)]
    struct TokenResponse {
        access_token: String,
        refresh_token: String,
        expires_in: u64,
    }
    
    let token_res: TokenResponse = res.json().await.map_err(|e| format!("Invalid JSON from provider: {}", e))?;
    
    let expires = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64 + (token_res.expires_in * 1000);
        
    Ok(OAuthTokenPayload {
        access: token_res.access_token,
        refresh: token_res.refresh_token,
        expires,
        account_id: Some("openai".to_string()),
    })
}

#[tauri::command]
pub async fn start_device_oauth(app: AppHandle, provider: String, _region: Option<String>) -> Result<DeviceOAuthInitPayload, String> {
    emit_log(&app, "gateway", format!("Starting device OAuth for provider: {}", provider), "stdout");
    let client = Client::new();
    let verifier = random_string();
    let challenge = pkce_challenge(&verifier);
    
    if provider == "minimax" {
        let base_url = if _region.as_deref() == Some("cn") { "https://api.minimaxi.com" } else { "https://api.minimax.io" };
        let client_id = "78257093-7e40-4613-99e0-527b14b39113";
        let state = random_string();
        
        let params = [
            ("response_type", "code"),
            ("client_id", client_id),
            ("scope", "group_id profile model.completion"),
            ("code_challenge", &challenge),
            ("code_challenge_method", "S256"),
            ("state", &state),
        ];
        
        let res = client.post(format!("{}/oauth/code", base_url))
            .header("x-request-id", random_string())
            .form(&params)
            .send()
            .await
            .map_err(|e| format!("Failed to connect to MiniMax: {}", e))?;
            
        if !res.status().is_success() {
            let text = res.text().await.unwrap_or_default();
            return Err(format!("MiniMax API Error: {}", text));
        }
        
        #[derive(Deserialize)]
        struct MiniMaxDeviceAuth {
            user_code: String,
            verification_uri: String,
            expired_in: u64,
            interval: Option<u64>,
        }
        
        let parsed: MiniMaxDeviceAuth = res.json().await.map_err(|e| format!("Failed to parse MiniMax response: {}", e))?;
        
        Ok(DeviceOAuthInitPayload {
            device_code: parsed.user_code.clone(),
            user_code: parsed.user_code,
            verification_uri: parsed.verification_uri,
            expires_in: parsed.expired_in,
            interval: parsed.interval.unwrap_or(2000),
            verifier,
        })
        
    } else if provider == "qwen" {
        let client_id = "f0304373b74a44d2b584a3fb70ca9e56";
        
        let params = [
            ("client_id", client_id),
            ("scope", "openid profile email model.completion"),
            ("code_challenge", &challenge),
            ("code_challenge_method", "S256"),
        ];
        
        let res = client.post("https://chat.qwen.ai/api/v1/oauth2/device/code")
            .header("x-request-id", random_string())
            .form(&params)
            .send()
            .await
            .map_err(|e| format!("Failed to connect to Qwen: {}", e))?;
            
        if !res.status().is_success() {
            let text = res.text().await.unwrap_or_default();
            return Err(format!("Qwen API Error: {}", text));
        }
        
        #[derive(Deserialize)]
        struct QwenDeviceAuth {
            device_code: String,
            user_code: String,
            verification_uri: String,
            verification_uri_complete: Option<String>,
            expires_in: u64,
            interval: Option<u64>,
        }
        
        let parsed: QwenDeviceAuth = res.json().await.map_err(|e| format!("Failed to parse Qwen response: {}", e))?;
        
        Ok(DeviceOAuthInitPayload {
            device_code: parsed.device_code,
            user_code: parsed.user_code,
            verification_uri: parsed.verification_uri_complete.unwrap_or(parsed.verification_uri),
            expires_in: parsed.expires_in,
            interval: parsed.interval.unwrap_or(2),
            verifier,
        })
    } else {
        Err(format!("Unsupported device OAuth provider: {}", provider))
    }
}

#[tauri::command]
pub async fn poll_device_oauth(app: AppHandle, provider: String, device_code: String, verifier: String, _region: Option<String>) -> Result<DeviceTokenResult, String> {
    // We don't log every poll to avoid spam, but we can log the first one or slow downs.
    let client = Client::new();
    
    if provider == "minimax" {
        let base_url = if _region.as_deref() == Some("cn") { "https://api.minimaxi.com" } else { "https://api.minimax.io" };
        let client_id = "78257093-7e40-4613-99e0-527b14b39113";
        
        let params = [
            ("grant_type", "urn:ietf:params:oauth:grant-type:user_code"),
            ("client_id", client_id),
            ("user_code", &device_code),
            ("code_verifier", &verifier),
        ];
        
        let res = client.post(format!("{}/oauth/token", base_url))
            .form(&params)
            .send()
            .await
            .map_err(|e| format!("Polling network error: {}", e))?;
            
        let text = res.text().await.unwrap_or_default();
        
        #[derive(Deserialize)]
        struct MiniMaxGenericResponse {
            status: Option<String>,
            message: Option<String>,
            access_token: Option<String>,
            refresh_token: Option<String>,
            expired_in: Option<u64>,
            error: Option<Value>,
        }
        
        let parsed: MiniMaxGenericResponse = serde_json::from_str(&text).map_err(|e| format!("MiniMax Parse Error: {} - Data: {}", e, text))?;
        
        if let Some(status) = parsed.status {
            if status == "error" {
                return Ok(DeviceTokenResult::Error { message: parsed.message.unwrap_or_else(|| "MiniMax unknown error".to_string()) });
            }
            if status == "success" {
                return Ok(DeviceTokenResult::Success {
                    token: OAuthTokenPayload {
                        access: parsed.access_token.unwrap_or_default(),
                        refresh: parsed.refresh_token.unwrap_or_default(),
                        expires: parsed.expired_in.unwrap_or(3600),
                        account_id: Some("minimax".to_string()),
                    }
                });
            }
        }
        
        // If slow down or authorization_pending
        let slow_down = text.contains("slow_down");
        Ok(DeviceTokenResult::Pending { slow_down })

    } else if provider == "qwen" {
        let client_id = "f0304373b74a44d2b584a3fb70ca9e56";
        
        let params = [
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ("client_id", client_id),
            ("device_code", &device_code),
            ("code_verifier", &verifier),
        ];
        
        let res = client.post("https://chat.qwen.ai/api/v1/oauth2/token")
            .form(&params)
            .send()
            .await
            .map_err(|e| format!("Polling network error: {}", e))?;
            
        let text = res.text().await.unwrap_or_default();
        
        #[derive(Deserialize)]
        struct QwenGenericResponse {
            error: Option<String>,
            access_token: Option<String>,
            refresh_token: Option<String>,
            expires_in: Option<u64>,
        }
        
        let parsed: QwenGenericResponse = serde_json::from_str(&text).map_err(|e| format!("Qwen Parse Error: {} - Data: {}", e, text))?;
        
        if let Some(err) = parsed.error {
            if err == "authorization_pending" {
                return Ok(DeviceTokenResult::Pending { slow_down: false });
            }
            if err == "slow_down" {
                return Ok(DeviceTokenResult::Pending { slow_down: true });
            }
            return Ok(DeviceTokenResult::Error { message: err });
        }
        
        if let Some(access_token) = parsed.access_token {
            let expires = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64 + (parsed.expires_in.unwrap_or(3600) * 1000);
                
            return Ok(DeviceTokenResult::Success {
                token: OAuthTokenPayload {
                    access: access_token,
                    refresh: parsed.refresh_token.unwrap_or_default(),
                    expires,
                    account_id: Some("qwen".to_string()),
                }
            });
        }
        
        Ok(DeviceTokenResult::Pending { slow_down: false })
    } else {
        Err(format!("Unsupported device OAuth provider: {}", provider))
    }
}

