pub fn opfs_write_sync(_key: &str, _data: &[u8]) -> Result<(), String> {
    Err("OPFS sync write unavailable in pure Rust context without JS bridge".to_string())
}

pub fn opfs_read_sync(_key: &str) -> Result<Vec<u8>, String> {
    Err("OPFS sync read unavailable in pure Rust context without JS bridge".to_string())
}

pub fn opfs_remove_sync(_key: &str) -> Result<(), String> {
    Err("OPFS sync remove unavailable in pure Rust context without JS bridge".to_string())
}

pub fn opfs_exists(_key: &str) -> bool {
    false
}
