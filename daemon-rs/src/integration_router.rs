#![allow(dead_code)]

use std::collections::{BTreeMap, BTreeSet};

const RECOGNIZED_AGENTS: [&str; 3] = ["opencode", "claude", "gemini"];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProjectInstance {
    pub instance_id: String,
    pub agent_type: String,
    pub tmux_window: Option<String>,
    pub channel_id: Option<String>,
    pub event_hook: bool,
    pub runtime_type: Option<String>,
    pub container_mode: bool,
    pub container_id: Option<String>,
    pub container_name: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProjectRecord {
    pub project_name: String,
    pub project_path: String,
    pub tmux_session: String,
    pub instances: BTreeMap<String, ProjectInstance>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChannelMapping {
    pub channel_id: String,
    pub project_name: String,
    pub agent_type: String,
    pub instance_id: Option<String>,
}

#[derive(Clone, Debug)]
pub struct AgentIntegrationResult {
    pub event_hook_installed: bool,
    pub info_messages: Vec<String>,
    pub warning_messages: Vec<String>,
}

pub trait BootstrapState {
    fn list_projects(&self) -> Vec<ProjectRecord>;
    fn set_project(&mut self, project: ProjectRecord);
    fn reload(&mut self);
}

pub trait BootstrapMessaging {
    fn register_channel_mappings(&mut self, mappings: Vec<ChannelMapping>);
}

pub trait IntegrationInstaller {
    fn install_agent_integration(
        &mut self,
        agent_type: &str,
        project_path: &str,
    ) -> AgentIntegrationResult;
    fn install_file_instruction(
        &mut self,
        project_path: &str,
        agent_type: &str,
    ) -> Result<(), String>;
    fn install_send_script(
        &mut self,
        project_path: &str,
        project_name: &str,
        port: u16,
    ) -> Result<(), String>;
}

pub struct ProjectBootstrap<'a, S, M, I>
where
    S: BootstrapState,
    M: BootstrapMessaging,
    I: IntegrationInstaller,
{
    state: &'a mut S,
    messaging: &'a mut M,
    installer: &'a mut I,
    hook_server_port: u16,
}

impl<'a, S, M, I> ProjectBootstrap<'a, S, M, I>
where
    S: BootstrapState,
    M: BootstrapMessaging,
    I: IntegrationInstaller,
{
    pub fn new(
        state: &'a mut S,
        messaging: &'a mut M,
        installer: &'a mut I,
        hook_server_port: u16,
    ) -> Self {
        Self {
            state,
            messaging,
            installer,
            hook_server_port,
        }
    }

    pub fn bootstrap_projects(&mut self) -> Vec<ProjectRecord> {
        let mut projects = self.state.list_projects();

        for project in &mut projects {
            let agent_types = collect_project_agent_types(project);
            if !agent_types
                .iter()
                .any(|agent_type| RECOGNIZED_AGENTS.contains(&agent_type.as_str()))
            {
                continue;
            }

            let mut integration_by_agent = BTreeMap::<String, AgentIntegrationResult>::new();
            for agent_type in &agent_types {
                let result = self
                    .installer
                    .install_agent_integration(agent_type, &project.project_path);
                integration_by_agent.insert(agent_type.clone(), result);
            }

            for agent_type in &agent_types {
                let _ = self
                    .installer
                    .install_file_instruction(&project.project_path, agent_type);
            }

            let _ = self.installer.install_send_script(
                &project.project_path,
                &project.project_name,
                self.hook_server_port,
            );

            let mut changed = false;
            for instance in project.instances.values_mut() {
                let should_enable = integration_by_agent
                    .get(&instance.agent_type)
                    .map(|result| result.event_hook_installed)
                    .unwrap_or(false);
                if should_enable && !instance.event_hook {
                    instance.event_hook = true;
                    changed = true;
                }
            }

            if changed {
                self.state.set_project(project.clone());
            }
        }

        self.register_mappings(&projects);
        projects
    }

    pub fn reload_channel_mappings(&mut self) {
        self.state.reload();
        let projects = self.state.list_projects();
        self.register_mappings(&projects);
    }

    fn register_mappings(&mut self, projects: &[ProjectRecord]) {
        let mappings = rebuild_channel_mappings(projects);
        if mappings.is_empty() {
            return;
        }
        self.messaging.register_channel_mappings(mappings);
    }
}

pub fn rebuild_channel_mappings(projects: &[ProjectRecord]) -> Vec<ChannelMapping> {
    let mut mappings = Vec::new();

    for project in projects {
        for instance in sorted_instances(project) {
            let Some(channel_id) = non_empty(instance.channel_id.as_deref()) else {
                continue;
            };
            mappings.push(ChannelMapping {
                channel_id: channel_id.to_string(),
                project_name: project.project_name.clone(),
                agent_type: instance.agent_type.clone(),
                instance_id: Some(instance.instance_id.clone()),
            });
        }
    }

    mappings
}

fn collect_project_agent_types(project: &ProjectRecord) -> BTreeSet<String> {
    sorted_instances(project)
        .iter()
        .map(|instance| instance.agent_type.clone())
        .collect()
}

fn sorted_instances(project: &ProjectRecord) -> Vec<&ProjectInstance> {
    let mut keys = project.instances.keys().cloned().collect::<Vec<_>>();
    keys.sort();
    keys.into_iter()
        .filter_map(|key| project.instances.get(&key))
        .collect::<Vec<_>>()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MessageAttachment {
    pub filename: String,
}

#[derive(Clone, Debug)]
pub struct IncomingMessage {
    pub agent_type: String,
    pub content: String,
    pub project_name: String,
    pub channel_id: String,
    pub message_id: Option<String>,
    pub mapped_instance_id: Option<String>,
    pub attachments: Vec<MessageAttachment>,
}

pub trait RouterState {
    fn get_project(&self, project_name: &str) -> Option<ProjectRecord>;
    fn update_last_active(&mut self, project_name: &str);
}

pub trait RouterMessaging {
    fn send_to_channel(&mut self, channel_id: &str, content: &str);
}

pub trait RouterRuntime {
    fn type_keys_to_window(
        &mut self,
        tmux_session: &str,
        window_name: &str,
        prompt: &str,
        agent_type: &str,
    ) -> Result<(), String>;
    fn send_enter_to_window(
        &mut self,
        tmux_session: &str,
        window_name: &str,
        agent_type: &str,
    ) -> Result<(), String>;
}

pub trait RouterPending {
    fn mark_pending(
        &mut self,
        project_name: &str,
        agent_type: &str,
        channel_id: &str,
        message_id: &str,
        instance_id: &str,
    ) -> Result<(), String>;
    fn ensure_pending(
        &mut self,
        project_name: &str,
        agent_type: &str,
        channel_id: &str,
        instance_id: &str,
    );
    fn set_prompt_preview(
        &mut self,
        project_name: &str,
        agent_type: &str,
        content: &str,
        instance_id: &str,
    );
    fn mark_error(&mut self, project_name: &str, agent_type: &str, instance_id: &str);
}

pub trait AttachmentProcessor {
    fn process_attachments(
        &mut self,
        attachments: &[MessageAttachment],
        project_path: &str,
        instance: &ProjectInstance,
    ) -> String;
}

pub trait SleepProvider {
    fn sleep_ms(&mut self, duration_ms: u64);
}

pub struct RouterOptions {
    pub sanitize_input: fn(&str) -> Option<String>,
}

pub struct BridgeMessageRouter<'a, S, M, R, P, A, Z>
where
    S: RouterState,
    M: RouterMessaging,
    R: RouterRuntime,
    P: RouterPending,
    A: AttachmentProcessor,
    Z: SleepProvider,
{
    state: &'a mut S,
    messaging: &'a mut M,
    runtime: &'a mut R,
    pending: &'a mut P,
    attachments: &'a mut A,
    sleeper: &'a mut Z,
    options: RouterOptions,
}

impl<'a, S, M, R, P, A, Z> BridgeMessageRouter<'a, S, M, R, P, A, Z>
where
    S: RouterState,
    M: RouterMessaging,
    R: RouterRuntime,
    P: RouterPending,
    A: AttachmentProcessor,
    Z: SleepProvider,
{
    pub fn new(
        state: &'a mut S,
        messaging: &'a mut M,
        runtime: &'a mut R,
        pending: &'a mut P,
        attachments: &'a mut A,
        sleeper: &'a mut Z,
        options: RouterOptions,
    ) -> Self {
        Self {
            state,
            messaging,
            runtime,
            pending,
            attachments,
            sleeper,
            options,
        }
    }

    pub fn route_message(&mut self, message: &IncomingMessage) {
        if message.content.trim().eq_ignore_ascii_case("help") {
            self.messaging
                .send_to_channel(&message.channel_id, &build_help_text());
            return;
        }

        let Some(project) = self.state.get_project(&message.project_name) else {
            self.messaging.send_to_channel(
                &message.channel_id,
                &format!(
                    "Warning: Project \"{}\" not found in state",
                    message.project_name
                ),
            );
            return;
        };

        let instance = resolve_instance(
            &project,
            &message.agent_type,
            non_empty(message.mapped_instance_id.as_deref()),
            &message.channel_id,
        );
        let Some(instance) = instance else {
            self.messaging.send_to_channel(
                &message.channel_id,
                "Warning: Agent instance mapping not found for this channel",
            );
            return;
        };

        let resolved_agent_type = instance.agent_type.clone();
        let instance_key = instance.instance_id.clone();
        let window_name = instance
            .tmux_window
            .clone()
            .unwrap_or_else(|| instance_key.clone());

        let mut enriched = message.content.clone();
        if !message.attachments.is_empty() {
            let markers = self.attachments.process_attachments(
                &message.attachments,
                &project.project_path,
                instance,
            );
            if !markers.is_empty() {
                enriched.push_str(&markers);
            }
        }

        let sanitized = (self.options.sanitize_input)(&enriched);
        let Some(sanitized) = sanitized else {
            self.messaging.send_to_channel(
                &message.channel_id,
                "Warning: Invalid message: empty, too long (>10000 chars), or contains invalid characters",
            );
            return;
        };

        if let Some(message_id) = non_empty(message.message_id.as_deref()) {
            if self
                .pending
                .mark_pending(
                    &project.project_name,
                    &resolved_agent_type,
                    &message.channel_id,
                    message_id,
                    &instance_key,
                )
                .is_err()
            {
                self.pending.ensure_pending(
                    &project.project_name,
                    &resolved_agent_type,
                    &message.channel_id,
                    &instance_key,
                );
            }
        } else {
            self.pending.ensure_pending(
                &project.project_name,
                &resolved_agent_type,
                &message.channel_id,
                &instance_key,
            );
        }

        self.pending.set_prompt_preview(
            &project.project_name,
            &resolved_agent_type,
            &message.content,
            &instance_key,
        );

        let submitted = self.submit_to_agent(
            &project.tmux_session,
            &window_name,
            &sanitized,
            &resolved_agent_type,
        );
        if let Err(error) = submitted {
            self.pending
                .mark_error(&project.project_name, &resolved_agent_type, &instance_key);
            self.messaging.send_to_channel(
                &message.channel_id,
                &build_delivery_failure_guidance(&project.project_name, &error),
            );
        }

        self.state.update_last_active(&project.project_name);
    }

    fn submit_to_agent(
        &mut self,
        tmux_session: &str,
        window_name: &str,
        prompt: &str,
        agent_type: &str,
    ) -> Result<(), String> {
        self.runtime.type_keys_to_window(
            tmux_session,
            window_name,
            prompt.trim_end(),
            agent_type,
        )?;

        let env_key = if agent_type == "opencode" {
            "DISCODE_OPENCODE_SUBMIT_DELAY_MS"
        } else {
            "DISCODE_SUBMIT_DELAY_MS"
        };
        let default_ms = if agent_type == "opencode" { 75 } else { 300 };
        let delay_ms = read_env_int(env_key, default_ms);

        self.sleeper.sleep_ms(delay_ms as u64);
        self.runtime
            .send_enter_to_window(tmux_session, window_name, agent_type)
    }
}

fn build_help_text() -> String {
    [
        "Discode - Chat with AI coding agents",
        "",
        "Just type a message to send it to your agent.",
        "Attach images or files and they will be forwarded automatically.",
        "",
        "Commands:",
        "help - Show this message",
        "",
        "Tip: The agent sees your message as keyboard input in its terminal session.",
    ]
    .join("\n")
}

fn build_delivery_failure_guidance(project_name: &str, error_message: &str) -> String {
    let lower = error_message.to_ascii_lowercase();
    let missing_target = lower.contains("can't find window") || lower.contains("can't find pane");
    if missing_target {
        return format!(
            "Warning: I couldn't deliver your message because the agent tmux window is not running.\nPlease restart the agent session, then send your message again:\n1) discode new --name {project_name}\n2) discode attach {project_name}",
        );
    }

    format!(
        "Warning: I couldn't deliver your message to the tmux agent session.\nPlease confirm the agent is running, then try again.\nIf needed, restart with discode new --name {project_name}.",
    )
}

fn resolve_instance<'a>(
    project: &'a ProjectRecord,
    agent_type: &str,
    mapped_instance_id: Option<&str>,
    channel_id: &str,
) -> Option<&'a ProjectInstance> {
    if let Some(instance_id) = mapped_instance_id {
        if let Some(instance) = project.instances.get(instance_id) {
            return Some(instance);
        }
    }

    for instance in sorted_instances(project) {
        if instance.channel_id.as_deref() == Some(channel_id) {
            return Some(instance);
        }
    }

    sorted_instances(project)
        .into_iter()
        .find(|instance| instance.agent_type == agent_type)
}

fn read_env_int(name: &str, default_value: i32) -> i32 {
    let Some(raw) = std::env::var(name).ok() else {
        return default_value;
    };
    let Ok(value) = raw.parse::<i32>() else {
        return default_value;
    };
    value
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.and_then(|raw| {
        if raw.trim().is_empty() {
            None
        } else {
            Some(raw)
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct MockBootstrapState {
        projects: Vec<ProjectRecord>,
        set_project_calls: Vec<ProjectRecord>,
        reload_calls: usize,
    }

    impl BootstrapState for MockBootstrapState {
        fn list_projects(&self) -> Vec<ProjectRecord> {
            self.projects.clone()
        }

        fn set_project(&mut self, project: ProjectRecord) {
            self.set_project_calls.push(project);
        }

        fn reload(&mut self) {
            self.reload_calls += 1;
        }
    }

    #[derive(Default)]
    struct MockBootstrapMessaging {
        mappings: Vec<Vec<ChannelMapping>>,
    }

    impl BootstrapMessaging for MockBootstrapMessaging {
        fn register_channel_mappings(&mut self, mappings: Vec<ChannelMapping>) {
            self.mappings.push(mappings);
        }
    }

    #[derive(Default)]
    struct MockInstaller {
        integration_calls: Vec<(String, String)>,
        file_instruction_calls: Vec<(String, String)>,
        send_script_calls: Vec<(String, String, u16)>,
        event_hook_installed: bool,
    }

    impl IntegrationInstaller for MockInstaller {
        fn install_agent_integration(
            &mut self,
            agent_type: &str,
            project_path: &str,
        ) -> AgentIntegrationResult {
            self.integration_calls
                .push((agent_type.to_string(), project_path.to_string()));
            AgentIntegrationResult {
                event_hook_installed: self.event_hook_installed,
                info_messages: Vec::new(),
                warning_messages: Vec::new(),
            }
        }

        fn install_file_instruction(
            &mut self,
            project_path: &str,
            agent_type: &str,
        ) -> Result<(), String> {
            self.file_instruction_calls
                .push((project_path.to_string(), agent_type.to_string()));
            Ok(())
        }

        fn install_send_script(
            &mut self,
            project_path: &str,
            project_name: &str,
            port: u16,
        ) -> Result<(), String> {
            self.send_script_calls
                .push((project_path.to_string(), project_name.to_string(), port));
            Ok(())
        }
    }

    #[derive(Default, Clone)]
    struct MockRouterState {
        projects: BTreeMap<String, ProjectRecord>,
        last_active_calls: Vec<String>,
    }

    impl RouterState for MockRouterState {
        fn get_project(&self, project_name: &str) -> Option<ProjectRecord> {
            self.projects.get(project_name).cloned()
        }

        fn update_last_active(&mut self, project_name: &str) {
            self.last_active_calls.push(project_name.to_string());
        }
    }

    #[derive(Default, Clone)]
    struct MockRouterMessaging {
        sent: Vec<(String, String)>,
    }

    impl RouterMessaging for MockRouterMessaging {
        fn send_to_channel(&mut self, channel_id: &str, content: &str) {
            self.sent
                .push((channel_id.to_string(), content.to_string()));
        }
    }

    #[derive(Default, Clone)]
    struct MockRouterRuntime {
        typed: Vec<(String, String, String, String)>,
        submitted: Vec<(String, String, String)>,
        fail_on_type: Option<String>,
    }

    impl RouterRuntime for MockRouterRuntime {
        fn type_keys_to_window(
            &mut self,
            tmux_session: &str,
            window_name: &str,
            prompt: &str,
            agent_type: &str,
        ) -> Result<(), String> {
            if let Some(error) = &self.fail_on_type {
                return Err(error.clone());
            }
            self.typed.push((
                tmux_session.to_string(),
                window_name.to_string(),
                prompt.to_string(),
                agent_type.to_string(),
            ));
            Ok(())
        }

        fn send_enter_to_window(
            &mut self,
            tmux_session: &str,
            window_name: &str,
            agent_type: &str,
        ) -> Result<(), String> {
            self.submitted.push((
                tmux_session.to_string(),
                window_name.to_string(),
                agent_type.to_string(),
            ));
            Ok(())
        }
    }

    #[derive(Default, Clone)]
    struct MockRouterPending {
        mark_pending_calls: Vec<(String, String, String, String, String)>,
        ensure_pending_calls: Vec<(String, String, String, String)>,
        prompt_preview_calls: Vec<(String, String, String, String)>,
        mark_error_calls: Vec<(String, String, String)>,
        fail_mark_pending: bool,
    }

    impl RouterPending for MockRouterPending {
        fn mark_pending(
            &mut self,
            project_name: &str,
            agent_type: &str,
            channel_id: &str,
            message_id: &str,
            instance_id: &str,
        ) -> Result<(), String> {
            self.mark_pending_calls.push((
                project_name.to_string(),
                agent_type.to_string(),
                channel_id.to_string(),
                message_id.to_string(),
                instance_id.to_string(),
            ));
            if self.fail_mark_pending {
                Err("mark pending failed".to_string())
            } else {
                Ok(())
            }
        }

        fn ensure_pending(
            &mut self,
            project_name: &str,
            agent_type: &str,
            channel_id: &str,
            instance_id: &str,
        ) {
            self.ensure_pending_calls.push((
                project_name.to_string(),
                agent_type.to_string(),
                channel_id.to_string(),
                instance_id.to_string(),
            ));
        }

        fn set_prompt_preview(
            &mut self,
            project_name: &str,
            agent_type: &str,
            content: &str,
            instance_id: &str,
        ) {
            self.prompt_preview_calls.push((
                project_name.to_string(),
                agent_type.to_string(),
                content.to_string(),
                instance_id.to_string(),
            ));
        }

        fn mark_error(&mut self, project_name: &str, agent_type: &str, instance_id: &str) {
            self.mark_error_calls.push((
                project_name.to_string(),
                agent_type.to_string(),
                instance_id.to_string(),
            ));
        }
    }

    #[derive(Default, Clone)]
    struct MockAttachmentProcessor {
        markers: String,
        calls: usize,
    }

    impl AttachmentProcessor for MockAttachmentProcessor {
        fn process_attachments(
            &mut self,
            _attachments: &[MessageAttachment],
            _project_path: &str,
            _instance: &ProjectInstance,
        ) -> String {
            self.calls += 1;
            self.markers.clone()
        }
    }

    #[derive(Default, Clone)]
    struct MockSleeper {
        sleeps: Vec<u64>,
    }

    impl SleepProvider for MockSleeper {
        fn sleep_ms(&mut self, duration_ms: u64) {
            self.sleeps.push(duration_ms);
        }
    }

    fn sample_project() -> ProjectRecord {
        let mut instances = BTreeMap::new();
        instances.insert(
            "claude".to_string(),
            ProjectInstance {
                instance_id: "claude".to_string(),
                agent_type: "claude".to_string(),
                tmux_window: Some("myapp-claude".to_string()),
                channel_id: Some("ch-primary".to_string()),
                event_hook: false,
                runtime_type: None,
                container_mode: false,
                container_id: None,
                container_name: None,
            },
        );
        instances.insert(
            "claude-2".to_string(),
            ProjectInstance {
                instance_id: "claude-2".to_string(),
                agent_type: "claude".to_string(),
                tmux_window: Some("myapp-claude-2".to_string()),
                channel_id: Some("ch-secondary".to_string()),
                event_hook: false,
                runtime_type: None,
                container_mode: true,
                container_id: Some("container-bbb".to_string()),
                container_name: Some("discode-myapp-claude-2".to_string()),
            },
        );

        ProjectRecord {
            project_name: "myapp".to_string(),
            project_path: "/tmp/myapp".to_string(),
            tmux_session: "bridge".to_string(),
            instances,
        }
    }

    fn opencode_project() -> ProjectRecord {
        let mut instances = BTreeMap::new();
        instances.insert(
            "opencode".to_string(),
            ProjectInstance {
                instance_id: "opencode".to_string(),
                agent_type: "opencode".to_string(),
                tmux_window: Some("demo-opencode".to_string()),
                channel_id: Some("ch-opencode".to_string()),
                event_hook: true,
                runtime_type: None,
                container_mode: false,
                container_id: None,
                container_name: None,
            },
        );

        ProjectRecord {
            project_name: "demo".to_string(),
            project_path: "/tmp/demo".to_string(),
            tmux_session: "bridge".to_string(),
            instances,
        }
    }

    #[test]
    fn bootstrap_rebuilds_mappings_and_enables_event_hook() {
        let mut state = MockBootstrapState {
            projects: vec![sample_project()],
            ..Default::default()
        };
        let mut messaging = MockBootstrapMessaging::default();
        let mut installer = MockInstaller {
            event_hook_installed: true,
            ..Default::default()
        };

        let mut bootstrap =
            ProjectBootstrap::new(&mut state, &mut messaging, &mut installer, 19000);
        bootstrap.bootstrap_projects();

        assert!(installer
            .integration_calls
            .iter()
            .any(|(agent, path)| agent == "claude" && path == "/tmp/myapp"));
        assert!(installer
            .file_instruction_calls
            .iter()
            .any(|(path, agent)| path == "/tmp/myapp" && agent == "claude"));
        assert!(installer
            .send_script_calls
            .iter()
            .any(|(path, project, port)| path == "/tmp/myapp"
                && project == "myapp"
                && *port == 19000));

        assert_eq!(state.set_project_calls.len(), 1);
        assert!(state.set_project_calls[0]
            .instances
            .values()
            .all(|instance| instance.event_hook));

        assert_eq!(messaging.mappings.len(), 1);
        assert_eq!(messaging.mappings[0].len(), 2);
        assert!(messaging.mappings[0]
            .iter()
            .any(|mapping| mapping.channel_id == "ch-primary"
                && mapping.instance_id.as_deref() == Some("claude")));
    }

    #[test]
    fn reload_channel_mappings_reloads_state() {
        let mut state = MockBootstrapState {
            projects: vec![sample_project()],
            ..Default::default()
        };
        let mut messaging = MockBootstrapMessaging::default();
        let mut installer = MockInstaller::default();

        let mut bootstrap =
            ProjectBootstrap::new(&mut state, &mut messaging, &mut installer, 18470);
        bootstrap.reload_channel_mappings();

        assert_eq!(state.reload_calls, 1);
        assert_eq!(messaging.mappings.len(), 1);
        assert_eq!(messaging.mappings[0].len(), 2);
    }

    #[test]
    fn router_routes_by_channel_and_mapped_instance_id() {
        let mut state = MockRouterState::default();
        state.projects.insert("myapp".to_string(), sample_project());

        let mut messaging = MockRouterMessaging::default();
        let mut runtime = MockRouterRuntime::default();
        let mut pending = MockRouterPending::default();
        let mut attachments = MockAttachmentProcessor::default();
        let mut sleeper = MockSleeper::default();

        {
            let mut router = BridgeMessageRouter::new(
                &mut state,
                &mut messaging,
                &mut runtime,
                &mut pending,
                &mut attachments,
                &mut sleeper,
                RouterOptions {
                    sanitize_input: |content| {
                        let trimmed = content.trim();
                        if trimmed.is_empty() {
                            None
                        } else {
                            Some(trimmed.to_string())
                        }
                    },
                },
            );

            router.route_message(&IncomingMessage {
                agent_type: "claude".to_string(),
                content: "hello channel".to_string(),
                project_name: "myapp".to_string(),
                channel_id: "ch-secondary".to_string(),
                message_id: Some("msg-2".to_string()),
                mapped_instance_id: None,
                attachments: Vec::new(),
            });

            router.route_message(&IncomingMessage {
                agent_type: "claude".to_string(),
                content: "explicit".to_string(),
                project_name: "myapp".to_string(),
                channel_id: "ch-primary".to_string(),
                message_id: Some("msg-3".to_string()),
                mapped_instance_id: Some("claude-2".to_string()),
                attachments: Vec::new(),
            });
        }

        assert_eq!(runtime.typed.len(), 2);
        assert_eq!(runtime.typed[0].1, "myapp-claude-2");
        assert_eq!(pending.mark_pending_calls[0].4, "claude-2");
        assert_eq!(runtime.typed[1].1, "myapp-claude-2");
    }

    #[test]
    fn router_injects_attachment_markers_into_prompt() {
        let mut state = MockRouterState::default();
        state.projects.insert("myapp".to_string(), sample_project());

        let mut messaging = MockRouterMessaging::default();
        let mut runtime = MockRouterRuntime::default();
        let mut pending = MockRouterPending::default();
        let mut attachments = MockAttachmentProcessor {
            markers: "\n[file:img.png]".to_string(),
            calls: 0,
        };
        let mut sleeper = MockSleeper::default();

        let mut router = BridgeMessageRouter::new(
            &mut state,
            &mut messaging,
            &mut runtime,
            &mut pending,
            &mut attachments,
            &mut sleeper,
            RouterOptions {
                sanitize_input: |content| Some(content.to_string()),
            },
        );

        router.route_message(&IncomingMessage {
            agent_type: "claude".to_string(),
            content: "check this".to_string(),
            project_name: "myapp".to_string(),
            channel_id: "ch-secondary".to_string(),
            message_id: None,
            mapped_instance_id: None,
            attachments: vec![MessageAttachment {
                filename: "img.png".to_string(),
            }],
        });

        assert_eq!(attachments.calls, 1);
        assert_eq!(runtime.typed.len(), 1);
        assert_eq!(runtime.typed[0].2, "check this\n[file:img.png]");
    }

    #[test]
    fn router_handles_project_and_mapping_edge_cases() {
        let mut state = MockRouterState::default();
        state.projects.insert("myapp".to_string(), sample_project());

        let mut messaging = MockRouterMessaging::default();
        let mut runtime = MockRouterRuntime::default();
        let mut pending = MockRouterPending::default();
        let mut attachments = MockAttachmentProcessor::default();
        let mut sleeper = MockSleeper::default();

        let mut router = BridgeMessageRouter::new(
            &mut state,
            &mut messaging,
            &mut runtime,
            &mut pending,
            &mut attachments,
            &mut sleeper,
            RouterOptions {
                sanitize_input: |_content| None,
            },
        );

        router.route_message(&IncomingMessage {
            agent_type: "claude".to_string(),
            content: "hello".to_string(),
            project_name: "missing".to_string(),
            channel_id: "ch-x".to_string(),
            message_id: None,
            mapped_instance_id: None,
            attachments: Vec::new(),
        });

        router.route_message(&IncomingMessage {
            agent_type: "gemini".to_string(),
            content: "hello".to_string(),
            project_name: "myapp".to_string(),
            channel_id: "ch-unknown".to_string(),
            message_id: None,
            mapped_instance_id: None,
            attachments: Vec::new(),
        });

        router.route_message(&IncomingMessage {
            agent_type: "claude".to_string(),
            content: "   ".to_string(),
            project_name: "myapp".to_string(),
            channel_id: "ch-primary".to_string(),
            message_id: None,
            mapped_instance_id: None,
            attachments: Vec::new(),
        });

        assert_eq!(runtime.typed.len(), 0);
        assert!(messaging
            .sent
            .iter()
            .any(|(_, body)| body.contains("not found in state")));
        assert!(messaging
            .sent
            .iter()
            .any(|(_, body)| body.contains("instance mapping not found")));
        assert!(messaging
            .sent
            .iter()
            .any(|(_, body)| body.contains("Invalid message")));
    }

    #[test]
    fn router_applies_agent_specific_submit_timing() {
        let mut state = MockRouterState::default();
        state
            .projects
            .insert("demo".to_string(), opencode_project());

        let mut messaging = MockRouterMessaging::default();
        let mut runtime = MockRouterRuntime::default();
        let mut pending = MockRouterPending::default();
        let mut attachments = MockAttachmentProcessor::default();
        let mut sleeper = MockSleeper::default();

        {
            let mut router = BridgeMessageRouter::new(
                &mut state,
                &mut messaging,
                &mut runtime,
                &mut pending,
                &mut attachments,
                &mut sleeper,
                RouterOptions {
                    sanitize_input: |content| Some(content.to_string()),
                },
            );

            router.route_message(&IncomingMessage {
                agent_type: "opencode".to_string(),
                content: "hello".to_string(),
                project_name: "demo".to_string(),
                channel_id: "ch-opencode".to_string(),
                message_id: Some("m1".to_string()),
                mapped_instance_id: None,
                attachments: Vec::new(),
            });

            std::env::set_var("DISCODE_OPENCODE_SUBMIT_DELAY_MS", "22");
            router.route_message(&IncomingMessage {
                agent_type: "opencode".to_string(),
                content: "hello-2".to_string(),
                project_name: "demo".to_string(),
                channel_id: "ch-opencode".to_string(),
                message_id: Some("m2".to_string()),
                mapped_instance_id: None,
                attachments: Vec::new(),
            });
            std::env::remove_var("DISCODE_OPENCODE_SUBMIT_DELAY_MS");
        }

        assert_eq!(sleeper.sleeps, vec![75, 22]);
    }

    #[test]
    fn router_marks_error_and_sends_delivery_guidance() {
        let mut state = MockRouterState::default();
        state.projects.insert("myapp".to_string(), sample_project());

        let mut messaging = MockRouterMessaging::default();
        let mut runtime = MockRouterRuntime {
            fail_on_type: Some("can't find window: myapp-claude".to_string()),
            ..Default::default()
        };
        let mut pending = MockRouterPending::default();
        let mut attachments = MockAttachmentProcessor::default();
        let mut sleeper = MockSleeper::default();

        let mut router = BridgeMessageRouter::new(
            &mut state,
            &mut messaging,
            &mut runtime,
            &mut pending,
            &mut attachments,
            &mut sleeper,
            RouterOptions {
                sanitize_input: |content| Some(content.to_string()),
            },
        );

        router.route_message(&IncomingMessage {
            agent_type: "claude".to_string(),
            content: "hello".to_string(),
            project_name: "myapp".to_string(),
            channel_id: "ch-primary".to_string(),
            message_id: Some("m1".to_string()),
            mapped_instance_id: None,
            attachments: Vec::new(),
        });

        assert_eq!(pending.mark_error_calls.len(), 1);
        assert!(messaging
            .sent
            .iter()
            .any(|(_, content)| content.contains("discode new --name myapp")));
        assert!(messaging
            .sent
            .iter()
            .any(|(_, content)| content.contains("discode attach myapp")));
    }

    #[test]
    fn router_falls_back_to_ensure_pending_when_mark_pending_fails() {
        let mut state = MockRouterState::default();
        state
            .projects
            .insert("demo".to_string(), opencode_project());

        let mut messaging = MockRouterMessaging::default();
        let mut runtime = MockRouterRuntime::default();
        let mut pending = MockRouterPending {
            fail_mark_pending: true,
            ..Default::default()
        };
        let mut attachments = MockAttachmentProcessor::default();
        let mut sleeper = MockSleeper::default();

        let mut router = BridgeMessageRouter::new(
            &mut state,
            &mut messaging,
            &mut runtime,
            &mut pending,
            &mut attachments,
            &mut sleeper,
            RouterOptions {
                sanitize_input: |content| Some(content.to_string()),
            },
        );

        router.route_message(&IncomingMessage {
            agent_type: "opencode".to_string(),
            content: "hello".to_string(),
            project_name: "demo".to_string(),
            channel_id: "ch-opencode".to_string(),
            message_id: Some("m1".to_string()),
            mapped_instance_id: None,
            attachments: Vec::new(),
        });

        assert_eq!(pending.mark_pending_calls.len(), 1);
        assert_eq!(pending.ensure_pending_calls.len(), 1);
    }

    #[test]
    fn rebuild_channel_mappings_skips_missing_channels() {
        let mut project = sample_project();
        if let Some(instance) = project.instances.get_mut("claude") {
            instance.channel_id = None;
        }

        let mappings = rebuild_channel_mappings(&[project]);
        assert_eq!(mappings.len(), 1);
        assert_eq!(mappings[0].channel_id, "ch-secondary");
    }
}
