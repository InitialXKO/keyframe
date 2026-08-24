use super::StorageAdapter;
use std::collections::HashMap;

pub struct MemoryStorage {
    data: HashMap<String, Vec<u8>>,
}

impl MemoryStorage {
    pub fn new() -> Self {
        Self {
            data: HashMap::new(),
        }
    }
}

impl StorageAdapter for MemoryStorage {
    fn write(&mut self, key: &str, data: &[u8]) -> Result<(), String> {
        self.data.insert(key.to_string(), data.to_vec());
        Ok(())
    }

    fn read(&self, key: &str) -> Result<Vec<u8>, String> {
        self.data
            .get(key)
            .cloned()
            .ok_or_else(|| format!("Key {} not found in memory storage", key))
    }

    fn remove(&mut self, key: &str) -> Result<(), String> {
        self.data.remove(key);
        Ok(())
    }

    fn exists(&self, key: &str) -> bool {
        self.data.contains_key(key)
    }
}
