pub mod memory;
pub mod opfs_bridge;


pub trait StorageAdapter {
    fn write(&mut self, key: &str, data: &[u8]) -> Result<(), String>;
    fn read(&self, key: &str) -> Result<Vec<u8>, String>;
    fn remove(&mut self, key: &str) -> Result<(), String>;
    fn exists(&self, key: &str) -> bool;
}

pub struct HybridStorage {
    memory_store: memory::MemoryStorage,
    use_opfs_fallback: bool,
}

impl HybridStorage {
    pub fn new(use_opfs_fallback: bool) -> Self {
        Self {
            memory_store: memory::MemoryStorage::new(),
            use_opfs_fallback,
        }
    }
}

impl StorageAdapter for HybridStorage {
    fn write(&mut self, key: &str, data: &[u8]) -> Result<(), String> {
        if self.use_opfs_fallback {
            if let Ok(()) = opfs_bridge::opfs_write_sync(key, data) {
                return Ok(());
            }
        }
        self.memory_store.write(key, data)
    }

    fn read(&self, key: &str) -> Result<Vec<u8>, String> {
        if self.use_opfs_fallback {
            if let Ok(data) = opfs_bridge::opfs_read_sync(key) {
                return Ok(data);
            }
        }
        self.memory_store.read(key)
    }

    fn remove(&mut self, key: &str) -> Result<(), String> {
        if self.use_opfs_fallback {
            let _ = opfs_bridge::opfs_remove_sync(key);
        }
        self.memory_store.remove(key)
    }

    fn exists(&self, key: &str) -> bool {
        if self.use_opfs_fallback && opfs_bridge::opfs_exists(key) {
            return true;
        }
        self.memory_store.exists(key)
    }
}
