//! Names: strings the core and JS share by number. A sound id (an `assets.json` sound, "step"), a rule event's name
//! ("wave-cleared"), a particle kind ("dust"): the tables and the systems use the string once, `Names::id` turns it
//! into a small number events carry, and the JS host reads the list back (`forge.name(i)`) to turn numbers into strings.
//! Id 0 is "no name". Ids never change once given (the list only grows), so JS can cache it by `len()`.
use std::collections::HashMap;

#[derive(Clone, Debug)]
pub struct Names {
    list: Vec<String>,
    map: HashMap<String, u32>,
}

impl Default for Names {
    fn default() -> Self {
        Self { list: vec![String::new()], map: HashMap::new() }
    }
}

impl Names {
    /// The id of `name`, given it the first time. An empty name is 0.
    pub fn id(&mut self, name: &str) -> u32 {
        if name.is_empty() {
            return 0;
        }
        if let Some(&i) = self.map.get(name) {
            return i;
        }
        let i = self.list.len() as u32;
        self.list.push(name.to_string());
        self.map.insert(name.to_string(), i);
        i
    }
    /// The id of `name` if it has one (never adds it).
    pub fn find(&self, name: &str) -> Option<u32> {
        self.map.get(name).copied()
    }
    pub fn get(&self, id: u32) -> &str {
        self.list.get(id as usize).map(|s| s.as_str()).unwrap_or("")
    }
    /// How many ids exist (0 included): JS re-reads the list when this grows.
    pub fn len(&self) -> usize {
        self.list.len()
    }
    pub fn is_empty(&self) -> bool {
        self.list.len() <= 1
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_stable_and_zero_is_none() {
        let mut n = Names::default();
        assert_eq!(n.id(""), 0);
        let a = n.id("step");
        let b = n.id("jump");
        assert_eq!(n.id("step"), a);
        assert_ne!(a, b);
        assert_eq!(n.get(b), "jump");
        assert_eq!(n.get(999), "");
        assert_eq!(n.len(), 3);
    }
}
