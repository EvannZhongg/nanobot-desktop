// TRACKING_ROUND_13
use serde::{Serialize, Deserialize};
use std::time::{SystemTime, UNIX_EPOCH};
use reqwest::Client;
use tauri::{AppHandle, Emitter};
use crate::emit_log;

use sha2::{Sha256, Digest};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OAuthTokenPayload {
    pub access: String,
    pub refresh: String,
    pub expires: u64,
    pub account_id: Option<String>,
}

#[derive(Serialize, Clone)]
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

#[derive(serde::Deserialize)]
struct MiniMaxGenericResponse {
    status: Option<String>,
    message: Option<String>,
    access_token: Option<String>,
    refresh_token: Option<String>,
    expired_in: Option<u64>,
}

#[derive(serde::Deserialize)]
struct QwenDeviceAuth {
    device_code: String,
    user_code: String,
    verification_uri: String,
    verification_uri_complete: Option<String>,
    expires_in: u64,
    interval: Option<u64>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum OAuthEvent {
    Success { provider: String, token: OAuthTokenPayload },
    Status { provider: String, message: String },
    Error { provider: String, message: String },
}

fn pkce_challenge(verifier: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(hasher.finalize())
}

fn random_string() -> String {
    let bytes: [u8; 32] = ::rand::random();
    URL_SAFE_NO_PAD.encode(bytes)
}

#[tauri::command]
pub async fn start_browser_oauth(app: AppHandle, provider: String) -> Result<OAuthTokenPayload, String> {
    emit_log(&app, "gateway", format!("Starting browser OAuth for provider: {}", provider), "stdout");
    
    let (client_id, authorize_url, token_url, scopes, redirect_uri_base) = if provider == "openai" {
        (
            "app_EMoamEEZ73f0CkXaXp7hrann",
            "https://auth.openai.com/oauth/authorize",
            "https://auth.openai.com/oauth/token",
            "openid profile email offline_access",
            "http://localhost:1455/auth/callback"
        )
    } else if provider == "google" {
        // Use standard gcloud CLI credentials for a smooth 'Gmail login' experience.
        // This allows users to authorize without creating their own GCP project.
        (
            "32555940559.apps.googleusercontent.com",
            "https://accounts.google.com/o/oauth2/v2/auth",
            "https://oauth2.googleapis.com/token",
            "openid profile email https://www.googleapis.com/auth/generative-language",
            "http://127.0.0.1"
        )
    } else {
        return Err(format!("Unsupported browser OAuth provider: {}", provider));
    };


    let (port, server): (u16, tiny_http::Server) = if provider == "openai" {
        let p = 1455;
        let s = tiny_http::Server::http(format!("127.0.0.1:{}", p))
            .map_err(|e| format!("Failed to start callback server on port {}: {}. Is another instance running?", p, e))?;
        (p, s)
    } else {
        // Use port 0 for dynamic allocation (supported by Google desktop apps)
        let s = tiny_http::Server::http("127.0.0.1:0")
            .map_err(|e| format!("Failed to start dynamic callback server: {}", e))?;
        let addr = s.server_addr();
        let port = match addr {
            tiny_http::ListenAddr::IP(std::net::SocketAddr::V4(a)) => a.port(),
            tiny_http::ListenAddr::IP(std::net::SocketAddr::V6(a)) => a.port(),
            _ => 1455, // Fallback port
        };
        (port, s)
    };

    let redirect_uri = if provider == "openai" { 
        redirect_uri_base.to_string() 
    } else {
        format!("{}:{}/auth/callback", redirect_uri_base, port)
    };
        
    let verifier = random_string();
    let challenge = pkce_challenge(&verifier);
    let state = random_string();
    
    let mut url = url::Url::parse(authorize_url).unwrap();
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("response_type", "code")
             .append_pair("client_id", client_id)
             .append_pair("redirect_uri", &redirect_uri)
             .append_pair("scope", scopes)
             .append_pair("code_challenge", &challenge)
             .append_pair("code_challenge_method", "S256")
             .append_pair("state", &state);
             
        if provider == "openai" {
            query.append_pair("id_token_add_organizations", "true")
                 .append_pair("codex_cli_simplified_flow", "true")
                 .append_pair("originator", "codex_cli_rs");
        } else if provider == "google" {
            query.append_pair("access_type", "offline")
                 .append_pair("prompt", "consent");
        }
    }
    let auth_url = url.to_string();
    emit_log(&app, "gateway", format!("Opening browser with URL: {}", auth_url), "stdout");
    if let Err(e) = open::that(&auth_url) {
        return Err(format!("Could not open browser: {}. Please go to this URL manually: {}", e, auth_url));
    }
    
    let mut obtained_code = None;
    let mut obtained_state = None;
    
    // Wait for callback (timeout after 5 minutes)
    for _ in 0..600 {
        let recv_res: Result<Option<tiny_http::Request>, Box<dyn std::error::Error + Send + Sync>> = server.recv_timeout(std::time::Duration::from_millis(500)).map_err(|e| e.into());
        if let Ok(Some(request)) = recv_res {
            let req_url = request.url().to_string();
            if req_url.starts_with("/auth/callback") {
                if let Ok(parsed) = url::Url::parse(&format!("http://127.0.0.1:{}", req_url)) {
                    let mut code = None;
                    let mut st = None;
                    for (k, v) in parsed.query_pairs() {
                        if k == "code" { code = Some(v.clone().into_owned()); }
                        if k == "state" { st = Some(v.into_owned()); }
                    }
                    if let Some(c) = code {
                        obtained_code = Some(c);
                        obtained_state = st;
                        let success_html = r#"
<!doctype html>
<html>
<head>
    <meta charset="utf-8">
    <title>Nanobot Authorization</title>
    <style>
        body { font-family: 'Inter', system-ui, -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0f172a; color: white; }
        .card { background: #1e293b; padding: 48px; border-radius: 24px; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5); text-align: center; max-width: 450px; border: 1px solid #334155; animation: slideUp 0.6s ease-out; }
        @keyframes slideUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
        .icon { font-size: 64px; margin-bottom: 24px; animation: bounce 2s infinite; }
        @keyframes bounce { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-10px); } }
        h2 { margin: 0 0 12px 0; color: #10b981; font-size: 28px; font-weight: 800; }
        p { color: #94a3b8; font-size: 16px; line-height: 1.6; margin-bottom: 32px; }
        .badge { display: inline-block; padding: 8px 20px; border-radius: 9999px; background: #10b98122; color: #10b981; font-size: 14px; font-weight: 600; border: 1px solid #10b98144; }
    </style>
</head>
<body>
    <div class='card'>
        <div class='icon'>🤖</div>
        <h2>Connection Successful!</h2>
        <p>Authentication complete. Your account has been securely linked to Nanobot Desktop. You can return to the app now.</p>
        <div class='badge'>You may safely close this tab</div>
        <script>setTimeout(() => window.close(), 3000);</script>
    </div>
</body>
</html>
"#;
                        let response = tiny_http::Response::from_string(success_html)
                            .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..]).unwrap());
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
    let mut params_vec = vec![
        ("grant_type", "authorization_code"),
        ("client_id", client_id),
        ("code", code.as_str()),
        ("code_verifier", verifier.as_str()),
        ("redirect_uri", redirect_uri.as_str()),
    ];
    
    // Add client_secret for google if using borrowed credentials
    if provider == "google" {
        params_vec.push(("client_secret", "otHCH_0T1_fS76XnS9Yg8J5c"));
    }
    
    let res = client.post(token_url)
        .form(&params_vec)
        .send()
        .await
        .map_err(|e| format!("Network error during token exchange: {}", e))?;
        
    let status = res.status();
    let text = res.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("{} returned an error ({}): {}", provider, status, text));
    }
    
    #[derive(Deserialize)]
    struct LocalTokenResponse {
        access_token: String,
        refresh_token: Option<String>,
        expires_in: u64,
    }
    
    let token_res: LocalTokenResponse = serde_json::from_str(&text).map_err(|e| format!("Invalid JSON from provider: {} - Data: {}", e, text))?;
    
    let expires = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64 + (token_res.expires_in * 1000);
        
    Ok(OAuthTokenPayload {
        access: token_res.access_token,
        refresh: token_res.refresh_token.unwrap_or_default(),
        expires,
        account_id: Some(provider),
    })
}

#[tauri::command]
pub async fn start_device_oauth(app: AppHandle, provider: String, _region: Option<String>) -> Result<DeviceOAuthInitPayload, String> {
    emit_log(&app, "gateway", format!("Starting device OAuth for provider: {}", provider), "stdout");
    let client = Client::new();
    let verifier = random_string();
    let challenge = pkce_challenge(&verifier);
    
    let init_payload = if provider == "minimax" {
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
        
        DeviceOAuthInitPayload {
            device_code: parsed.user_code.clone(),
            user_code: parsed.user_code,
            verification_uri: parsed.verification_uri,
            expires_in: parsed.expired_in,
            interval: parsed.interval.unwrap_or(2000),
            verifier: verifier.clone(),
        }
        
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
            
            let status = res.status();
            let text = res.text().await.unwrap_or_default();
            if !status.is_success() {
                return Err(format!("Qwen API Error ({}): {}", status, text));
            }
            
            let parsed: QwenDeviceAuth = serde_json::from_str(&text).map_err(|e| format!("Failed to parse Qwen response: {}", e))?;
        
        DeviceOAuthInitPayload {
            device_code: parsed.device_code,
            user_code: parsed.user_code,
            verification_uri: parsed.verification_uri_complete.unwrap_or(parsed.verification_uri),
            expires_in: parsed.expires_in,
            interval: parsed.interval.unwrap_or(2),
            verifier: verifier.clone(),
        }
    } else {
        return Err(format!("Unsupported device OAuth provider: {}", provider));
    };

    // Spawn background polling task
    let app_handle = app.clone();
    let provider_clone = provider.clone();
    let region_clone = _region.clone();
    let init_payload_clone = init_payload.clone();
    
    tauri::async_runtime::spawn(async move {
        let _ = poll_and_emit(app_handle, provider_clone, init_payload_clone, region_clone).await;
    });

    Ok(init_payload)
}

async fn poll_and_emit(app: AppHandle, provider: String, payload: DeviceOAuthInitPayload, region: Option<String>) -> Result<(), String> {
    let mut interval = std::time::Duration::from_secs(payload.interval);
    if provider == "minimax" {
        interval = std::time::Duration::from_millis(payload.interval);
    }
    
    let expires_at = SystemTime::now() + std::time::Duration::from_secs(payload.expires_in);

    while SystemTime::now() < expires_at {
        let result = poll_device_oauth(app.clone(), provider.clone(), payload.device_code.clone(), payload.verifier.clone(), region.clone()).await;
        
        match result {
            Ok(DeviceTokenResult::Success { token }) => {
                let _ = app.emit("oauth-event", OAuthEvent::Success { provider, token });
                return Ok(());
            }
            Ok(DeviceTokenResult::Error { message }) => {
                let _ = app.emit("oauth-event", OAuthEvent::Error { provider, message });
                return Err("Polling error".to_string());
            }
            Ok(DeviceTokenResult::Pending { slow_down }) => {
                if slow_down {
                    interval += std::time::Duration::from_secs(1);
                    let _ = app.emit("oauth-event", OAuthEvent::Status { provider: provider.clone(), message: "Slowing down polling...".to_string() });
                }
            }
            Err(e) => {
                let _ = app.emit("oauth-event", OAuthEvent::Error { provider: provider.clone(), message: e });
                return Err("Network error".to_string());
            }
        }
        tokio::time::sleep(interval).await;
    }
    
    let _ = app.emit("oauth-event", OAuthEvent::Error { provider, message: "Authorization timed out".to_string() });
    Ok(())
}

#[tauri::command]
pub async fn poll_device_oauth(_app: AppHandle, provider: String, device_code: String, verifier: String, _region: Option<String>) -> Result<DeviceTokenResult, String> {
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
            
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        
        let parsed: MiniMaxGenericResponse = serde_json::from_str(&text).map_err(|e| format!("MiniMax Parse Error: {} - Data: {}", e, text))?;
        
        if status.is_success() {
            if let Some(parsed_status) = parsed.status {
                if parsed_status == "error" {
                    return Ok(DeviceTokenResult::Error { message: parsed.message.unwrap_or_else(|| "MiniMax unknown error".to_string()) });
                }
                if parsed_status == "success" {
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
            
        let _status = res.status();
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

