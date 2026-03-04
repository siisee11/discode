#![allow(clippy::module_name_repetitions)]

use serde_json::{Map, Value};
use std::fs;
use std::path::Path;

pub const CONFIG_FILE_NAME: &str = "config.json";
pub const STATE_FILE_NAME: &str = "state.json";

#[derive(Debug, Clone)]
pub struct CompatConfig {
    raw: Value,
}

impl CompatConfig {
    pub fn load(path: &Path) -> Self {
        let raw = read_json_object_or_default(path);
        Self { raw }
    }

    pub fn runtime_mode(&self) -> &'static str {
        normalize_runtime_mode(
            self.raw
                .as_object()
                .and_then(|object| object.get("runtimeMode"))
                .and_then(Value::as_str),
        )
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn raw(&self) -> &Value {
        &self.raw
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn save(&self, path: &Path) -> Result<(), String> {
        write_pretty_json(path, &self.raw)
    }
}

#[derive(Debug, Clone)]
pub struct CompatState {
    normalized: Value,
}

impl CompatState {
    pub fn load(path: &Path) -> Self {
        let raw = read_json_object_or_default(path);
        let normalized = normalize_state_json(&raw);
        Self { normalized }
    }

    pub fn normalized(&self) -> &Value {
        &self.normalized
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn save(&self, path: &Path) -> Result<(), String> {
        write_pretty_json(path, &self.normalized)
    }
}

pub fn normalize_runtime_mode(value: Option<&str>) -> &'static str {
    if value == Some("pty-rust") {
        "pty-rust"
    } else {
        "tmux"
    }
}

pub fn normalize_state_json(input: &Value) -> Value {
    let mut state = object_or_empty(input);
    let projects = state
        .get("projects")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let mut normalized_projects = Map::new();
    for (project_name, project_value) in projects {
        let Some(project_obj) = project_value.as_object() else {
            continue;
        };
        normalized_projects.insert(
            project_name,
            Value::Object(normalize_project_object(project_obj)),
        );
    }

    state.insert("projects".to_string(), Value::Object(normalized_projects));
    Value::Object(state)
}

fn normalize_project_object(project: &Map<String, Value>) -> Map<String, Value> {
    let mut normalized_project = project.clone();
    let instances = normalize_instance_map(project);
    let (agents, discord_channels, tmux_windows, event_hooks) = derive_legacy_maps(&instances);

    normalized_project.insert("instances".to_string(), Value::Object(instances));
    normalized_project.insert("agents".to_string(), Value::Object(agents));
    normalized_project.insert(
        "discordChannels".to_string(),
        Value::Object(discord_channels),
    );

    if tmux_windows.is_empty() {
        normalized_project.remove("tmuxWindows");
    } else {
        normalized_project.insert("tmuxWindows".to_string(), Value::Object(tmux_windows));
    }

    if event_hooks.is_empty() {
        normalized_project.remove("eventHooks");
    } else {
        normalized_project.insert("eventHooks".to_string(), Value::Object(event_hooks));
    }

    normalized_project
}

fn normalize_instance_map(project: &Map<String, Value>) -> Map<String, Value> {
    let mut normalized = Map::new();

    if let Some(instances) = project.get("instances").and_then(Value::as_object) {
        for (raw_key, raw_value) in instances {
            let Some(instance_obj) = raw_value.as_object() else {
                continue;
            };

            let instance_id = non_empty_string(instance_obj.get("instanceId")).or_else(|| {
                if raw_key.trim().is_empty() {
                    None
                } else {
                    Some(raw_key.to_string())
                }
            });

            let Some(instance_id) = instance_id else {
                continue;
            };

            let agent_type = non_empty_trimmed_string(instance_obj.get("agentType"));
            let Some(agent_type) = agent_type else {
                continue;
            };

            let channel_id = non_empty_string(
                instance_obj
                    .get("channelId")
                    .or_else(|| instance_obj.get("discordChannelId")),
            );

            let mut instance = instance_obj.clone();
            instance.insert("instanceId".to_string(), Value::String(instance_id.clone()));
            instance.insert("agentType".to_string(), Value::String(agent_type));
            set_optional_string(
                &mut instance,
                "tmuxWindow",
                non_empty_string(instance_obj.get("tmuxWindow")),
            );
            set_optional_string(&mut instance, "channelId", channel_id);
            instance.remove("discordChannelId");
            set_optional_bool(
                &mut instance,
                "eventHook",
                instance_obj.get("eventHook").and_then(Value::as_bool),
            );

            if instance_obj.get("containerMode").and_then(Value::as_bool) == Some(true) {
                instance.insert("containerMode".to_string(), Value::Bool(true));
            } else {
                instance.remove("containerMode");
            }

            set_optional_string(
                &mut instance,
                "containerId",
                non_empty_string(instance_obj.get("containerId")),
            );
            set_optional_string(
                &mut instance,
                "containerName",
                non_empty_string(instance_obj.get("containerName")),
            );

            let runtime_type = instance_obj.get("runtimeType").and_then(Value::as_str);
            if matches!(runtime_type, Some("tmux") | Some("sdk")) {
                instance.insert(
                    "runtimeType".to_string(),
                    Value::String(runtime_type.unwrap_or("tmux").to_string()),
                );
            } else {
                instance.remove("runtimeType");
            }

            set_optional_string(
                &mut instance,
                "sdkSessionId",
                non_empty_string(instance_obj.get("sdkSessionId")),
            );

            normalized.insert(instance_id, Value::Object(instance));
        }
    }

    if !normalized.is_empty() {
        return sort_object_by_key(&normalized);
    }

    normalize_legacy_instances(project)
}

fn normalize_legacy_instances(project: &Map<String, Value>) -> Map<String, Value> {
    let mut keys: Vec<String> = Vec::new();

    if let Some(agents) = project.get("agents").and_then(Value::as_object) {
        for (agent_type, enabled) in agents {
            if enabled.as_bool() == Some(true) {
                keys.push(agent_type.to_string());
            }
        }
    }

    for source in ["discordChannels", "tmuxWindows", "eventHooks"] {
        if let Some(map) = project.get(source).and_then(Value::as_object) {
            for agent_type in map.keys() {
                if is_agent_disabled(project, agent_type) {
                    continue;
                }
                keys.push(agent_type.to_string());
            }
        }
    }

    keys.sort();
    keys.dedup();

    let mut instances = Map::new();
    for agent_type in keys {
        if agent_type.trim().is_empty() {
            continue;
        }
        let mut instance = Map::new();
        instance.insert("instanceId".to_string(), Value::String(agent_type.clone()));
        instance.insert("agentType".to_string(), Value::String(agent_type.clone()));

        set_optional_string(
            &mut instance,
            "tmuxWindow",
            project
                .get("tmuxWindows")
                .and_then(Value::as_object)
                .and_then(|map| map.get(&agent_type))
                .and_then(|value| non_empty_string(Some(value))),
        );

        set_optional_string(
            &mut instance,
            "channelId",
            project
                .get("discordChannels")
                .and_then(Value::as_object)
                .and_then(|map| map.get(&agent_type))
                .and_then(|value| non_empty_string(Some(value))),
        );

        set_optional_bool(
            &mut instance,
            "eventHook",
            project
                .get("eventHooks")
                .and_then(Value::as_object)
                .and_then(|map| map.get(&agent_type))
                .and_then(Value::as_bool),
        );

        instances.insert(agent_type, Value::Object(instance));
    }

    instances
}

fn derive_legacy_maps(
    instances: &Map<String, Value>,
) -> (
    Map<String, Value>,
    Map<String, Value>,
    Map<String, Value>,
    Map<String, Value>,
) {
    let sorted = sort_object_by_key(instances);

    let mut agents = Map::new();
    let mut discord_channels = Map::new();
    let mut tmux_windows = Map::new();
    let mut event_hooks = Map::new();

    for (_, instance_value) in sorted {
        let Some(instance) = instance_value.as_object() else {
            continue;
        };
        let Some(agent_type) = instance.get("agentType").and_then(Value::as_str) else {
            continue;
        };

        agents.insert(agent_type.to_string(), Value::Bool(true));

        if !discord_channels.contains_key(agent_type) {
            if let Some(channel_id) = non_empty_string(instance.get("channelId")) {
                discord_channels.insert(agent_type.to_string(), Value::String(channel_id));
            }
        }

        if !tmux_windows.contains_key(agent_type) {
            if let Some(tmux_window) = non_empty_string(instance.get("tmuxWindow")) {
                tmux_windows.insert(agent_type.to_string(), Value::String(tmux_window));
            }
        }

        if !event_hooks.contains_key(agent_type) {
            if let Some(event_hook) = instance.get("eventHook").and_then(Value::as_bool) {
                event_hooks.insert(agent_type.to_string(), Value::Bool(event_hook));
            }
        }
    }

    (agents, discord_channels, tmux_windows, event_hooks)
}

fn is_agent_disabled(project: &Map<String, Value>, agent_type: &str) -> bool {
    project
        .get("agents")
        .and_then(Value::as_object)
        .and_then(|agents| agents.get(agent_type))
        .and_then(Value::as_bool)
        == Some(false)
}

fn object_or_empty(value: &Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

fn non_empty_string(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).and_then(|raw| {
        if raw.trim().is_empty() {
            None
        } else {
            Some(raw.to_string())
        }
    })
}

fn non_empty_trimmed_string(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).and_then(|raw| {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn set_optional_string(target: &mut Map<String, Value>, key: &str, value: Option<String>) {
    if let Some(value) = value {
        target.insert(key.to_string(), Value::String(value));
    } else {
        target.remove(key);
    }
}

fn set_optional_bool(target: &mut Map<String, Value>, key: &str, value: Option<bool>) {
    if let Some(value) = value {
        target.insert(key.to_string(), Value::Bool(value));
    } else {
        target.remove(key);
    }
}

fn sort_object_by_key(object: &Map<String, Value>) -> Map<String, Value> {
    let mut keys: Vec<String> = object.keys().cloned().collect();
    keys.sort();

    let mut sorted = Map::new();
    for key in keys {
        if let Some(value) = object.get(&key) {
            sorted.insert(key, value.clone());
        }
    }
    sorted
}

fn read_json_object_or_default(path: &Path) -> Value {
    let raw = match fs::read_to_string(path) {
        Ok(value) => value,
        Err(_) => return Value::Object(Map::new()),
    };

    match serde_json::from_str::<Value>(&raw) {
        Ok(value) if value.is_object() => value,
        _ => Value::Object(Map::new()),
    }
}

#[cfg_attr(not(test), allow(dead_code))]
fn write_pretty_json(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create directory {}: {error}", parent.display()))?;
    }
    let payload = serde_json::to_string_pretty(value)
        .map_err(|error| format!("Failed to encode json: {error}"))?;
    fs::write(path, format!("{payload}\n"))
        .map_err(|error| format!("Failed to write {}: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp_dir(prefix: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be valid")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("{prefix}-{nonce}"));
        std::fs::create_dir_all(&path).expect("temp dir should be created");
        path
    }

    #[test]
    fn config_runtime_mode_normalizes_like_typescript() {
        let config = CompatConfig {
            raw: serde_json::json!({ "runtimeMode": "pty-rust" }),
        };
        assert_eq!(config.runtime_mode(), "pty-rust");

        let config = CompatConfig {
            raw: serde_json::json!({ "runtimeMode": "pty" }),
        };
        assert_eq!(config.runtime_mode(), "tmux");

        let config = CompatConfig {
            raw: serde_json::json!({}),
        };
        assert_eq!(config.runtime_mode(), "tmux");
    }

    #[test]
    fn state_loader_normalizes_legacy_maps_to_instances() {
        let state = serde_json::json!({
            "projects": {
                "demo": {
                    "projectName": "demo",
                    "projectPath": "/tmp/demo",
                    "tmuxSession": "agent-demo",
                    "agents": { "claude": true },
                    "discordChannels": { "claude": "ch-1" },
                    "tmuxWindows": { "claude": "demo-claude" },
                    "eventHooks": { "claude": true }
                }
            }
        });

        let normalized = normalize_state_json(&state);
        let instance = normalized["projects"]["demo"]["instances"]["claude"].clone();
        assert_eq!(instance["instanceId"], Value::String("claude".to_string()));
        assert_eq!(instance["agentType"], Value::String("claude".to_string()));
        assert_eq!(instance["channelId"], Value::String("ch-1".to_string()));
        assert_eq!(
            instance["tmuxWindow"],
            Value::String("demo-claude".to_string())
        );
        assert_eq!(instance["eventHook"], Value::Bool(true));
    }

    #[test]
    fn state_loader_supports_legacy_discord_channel_id_alias() {
        let state = serde_json::json!({
            "projects": {
                "demo": {
                    "projectName": "demo",
                    "projectPath": "/tmp/demo",
                    "tmuxSession": "agent-demo",
                    "agents": {},
                    "discordChannels": {},
                    "instances": {
                        "claude": {
                            "instanceId": "claude",
                            "agentType": "claude",
                            "discordChannelId": "legacy-ch-1"
                        }
                    }
                }
            }
        });

        let normalized = normalize_state_json(&state);
        assert_eq!(
            normalized["projects"]["demo"]["instances"]["claude"]["channelId"],
            Value::String("legacy-ch-1".to_string())
        );
        assert_eq!(
            normalized["projects"]["demo"]["discordChannels"]["claude"],
            Value::String("legacy-ch-1".to_string())
        );
    }

    #[test]
    fn state_roundtrip_preserves_unknown_fields() {
        let dir = unique_temp_dir("discode-daemon-rs-state");
        let path = dir.join(STATE_FILE_NAME);
        let payload = serde_json::json!({
            "projects": {
                "demo": {
                    "projectName": "demo",
                    "projectPath": "/tmp/demo",
                    "tmuxSession": "agent-demo",
                    "agents": {},
                    "discordChannels": {},
                    "customProject": { "value": 1 },
                    "instances": {
                        "claude": {
                            "instanceId": "claude",
                            "agentType": "claude",
                            "channelId": "ch-1",
                            "customInstance": "keep-me"
                        }
                    }
                }
            },
            "customRoot": "root-value"
        });
        std::fs::write(
            &path,
            serde_json::to_string_pretty(&payload).expect("payload should encode"),
        )
        .expect("state fixture should be written");

        let state = CompatState::load(&path);
        state.save(&path).expect("state should be saved");

        let reloaded = CompatState::load(&path);
        assert_eq!(
            reloaded.normalized()["customRoot"],
            Value::String("root-value".to_string())
        );
        assert_eq!(
            reloaded.normalized()["projects"]["demo"]["customProject"]["value"],
            Value::Number(1.into())
        );
        assert_eq!(
            reloaded.normalized()["projects"]["demo"]["instances"]["claude"]["customInstance"],
            Value::String("keep-me".to_string())
        );
    }

    #[test]
    fn config_roundtrip_preserves_unknown_fields() {
        let dir = unique_temp_dir("discode-daemon-rs-config");
        let path = dir.join(CONFIG_FILE_NAME);
        let payload = serde_json::json!({
            "hookServerPort": 18470,
            "runtimeMode": "pty-rust",
            "customField": { "enabled": true }
        });
        std::fs::write(
            &path,
            serde_json::to_string_pretty(&payload).expect("payload should encode"),
        )
        .expect("config fixture should be written");

        let config = CompatConfig::load(&path);
        assert_eq!(config.runtime_mode(), "pty-rust");
        config.save(&path).expect("config should be saved");
        let reloaded = CompatConfig::load(&path);
        assert_eq!(reloaded.raw()["customField"]["enabled"], Value::Bool(true));
    }
}
