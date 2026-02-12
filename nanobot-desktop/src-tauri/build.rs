fn main() {
    // Ensure optional runtime resources exist for dev builds so Tauri's
    // resource globbing doesn't fail when the embedded runtime isn't prepared.
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".into());
    let _ = std::env::set_current_dir(&manifest_dir);
    let resources_root = std::path::Path::new(&manifest_dir).join("resources");
    ensure_resource_placeholders(&resources_root);

    tauri_build::build();
}

fn ensure_resource_placeholders(resources_root: &std::path::Path) {
    let python_dir = resources_root.join("python");
    let site_packages_dir = resources_root.join("site-packages");
    let manifest_file = resources_root.join("runtime_manifest.txt");
    let python_placeholder = python_dir.join("placeholder.txt");
    let site_placeholder = site_packages_dir.join("placeholder.txt");

    let _ = std::fs::create_dir_all(&python_dir);
    let _ = std::fs::create_dir_all(&site_packages_dir);
    if !python_placeholder.exists() {
        let _ = std::fs::write(&python_placeholder, "placeholder");
    }
    if !site_placeholder.exists() {
        let _ = std::fs::write(&site_placeholder, "placeholder");
    }
    if !manifest_file.exists() {
        let _ = std::fs::write(&manifest_file, "");
    }
}
