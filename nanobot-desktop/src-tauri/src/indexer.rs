use ignore::WalkBuilder;
use serde::Serialize;

#[derive(Serialize)]
pub struct SearchResult {
    pub path: String,
    pub is_dir: bool,
}

#[tauri::command]
pub async fn search_workspace(workspace_dir: String, pattern: String) -> Result<Vec<SearchResult>, String> {
    let mut results = Vec::new();
    let walker = WalkBuilder::new(&workspace_dir)
        .hidden(false)
        .ignore(true)
        .git_ignore(true)
        .build();

    let term = pattern.to_lowercase();
    for result in walker {
        match result {
            Ok(entry) => {
                let path_str = entry.path().to_string_lossy().to_string();
                // Simple sub-string match on the path for demonstration of "ripgrep-like" fast path filtering
                // Real ripgrep would read file content, but for "workspace file search" we filter paths first
                if term.is_empty() || path_str.to_lowercase().contains(&term) {
                    if let Some(file_type) = entry.file_type() {
                        results.push(SearchResult {
                            path: path_str,
                            is_dir: file_type.is_dir(),
                        });
                        // Limit results to prevent UI freeze
                        if results.len() >= 1000 {
                            break;
                        }
                    }
                }
            }
            Err(_) => continue,
        }
    }
    Ok(results)
}
