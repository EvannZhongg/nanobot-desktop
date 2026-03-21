use rusqlite::{params, Connection, Result as SqlResult};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use text_splitter::TextSplitter;
use uuid::Uuid;

pub struct DbState(pub Mutex<Connection>);

#[derive(Serialize, Deserialize, Clone)]
pub struct Chunk {
    pub id: String,
    pub text: String,
    // Store vector as JSON string or blob in reality, but keeping it simple
}

// Initialize SQLite DB
pub fn init_db(db_path: &str) -> SqlResult<Connection> {
    let conn = Connection::open(db_path)?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS document_chunks (
            id TEXT PRIMARY KEY,
            content TEXT NOT NULL
        )",
        [],
    )?;
    Ok(conn)
}

#[tauri::command]
pub async fn chunk_and_store(
    text: String,
    state: tauri::State<'_, DbState>,
) -> Result<Vec<String>, String> {
    // 1. Chunking text using text-splitter
    let splitter = TextSplitter::new(500);
    let chunks: Vec<&str> = splitter.chunks(&text).collect();

    let mut chunk_ids = Vec::new();

    // 2. Store to SQLite
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    
    for chunk_text in chunks {
        let id = Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO document_chunks (id, content) VALUES (?1, ?2)",
            params![id, chunk_text],
        )
        .map_err(|e| e.to_string())?;
        chunk_ids.push(id);
    }

    Ok(chunk_ids)
}

#[tauri::command]
pub async fn search_chunks(
    query: String,
    state: tauri::State<'_, DbState>,
) -> Result<Vec<Chunk>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    
    // Fallback to simple LIKE search if no vector extension is loaded.
    // In a full implementation, you'd use sqlite-vec or pgvector and do cosine similarity.
    let mut stmt = conn
        .prepare("SELECT id, content FROM document_chunks WHERE content LIKE ?1 LIMIT 10")
        .map_err(|e| e.to_string())?;
    
    let search_term = format!("%{}%", query);
    let chunk_iter = stmt
        .query_map(params![search_term], |row| {
            Ok(Chunk {
                id: row.get(0)?,
                text: row.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut results = Vec::new();
    for c in chunk_iter.flatten() {
        results.push(c);
    }

    Ok(results)
}
