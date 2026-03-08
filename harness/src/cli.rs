use std::path::PathBuf;

#[derive(Debug, PartialEq, Eq)]
pub enum CleanupAction {
    Scan { fail_on_error: bool },
    Grade,
    Fix,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ObservabilityAction {
    Start,
    Stop,
    Query { kind: QueryKind, query: String },
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum QueryKind {
    Logs,
    Metrics,
    Traces,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Action {
    Help,
    Boot,
    Stop,
    Example,
    Smoke,
    Test,
    Lint,
    Typecheck,
    Audit { target: PathBuf },
    Cleanup(CleanupAction),
    Observability(ObservabilityAction),
}

pub fn parse_action(args: &[String]) -> Result<Action, String> {
    if args.is_empty() || matches!(args[0].as_str(), "-h" | "--help" | "help") {
        return Ok(Action::Help);
    }

    match args[0].as_str() {
        "boot" => Ok(Action::Boot),
        "stop" => Ok(Action::Stop),
        "example" => Ok(Action::Example),
        "smoke" => Ok(Action::Smoke),
        "test" => Ok(Action::Test),
        "lint" => Ok(Action::Lint),
        "typecheck" => Ok(Action::Typecheck),
        "audit" => {
            if args.len() > 2 {
                return Err("Usage: harnesscli audit [path]".to_string());
            }
            Ok(Action::Audit {
                target: args
                    .get(1)
                    .map(PathBuf::from)
                    .unwrap_or_else(|| PathBuf::from(".")),
            })
        }
        "cleanup" => parse_cleanup(args),
        "observability" => parse_observability(args),
        other => Err(format!("Unknown harness subcommand: {other}")),
    }
}

fn parse_cleanup(args: &[String]) -> Result<Action, String> {
    let Some(subcommand) = args.get(1).map(String::as_str) else {
        return Err("Usage: harnesscli cleanup <scan|grade|fix> [args...]".to_string());
    };

    match subcommand {
        "scan" => {
            let allowed = ["--fail-on-error"];
            for arg in &args[2..] {
                if !allowed.contains(&arg.as_str()) {
                    return Err(format!(
                        "Unknown cleanup scan argument: {arg}. Supported: --fail-on-error"
                    ));
                }
            }
            Ok(Action::Cleanup(CleanupAction::Scan {
                fail_on_error: args[2..].iter().any(|arg| arg == "--fail-on-error"),
            }))
        }
        "grade" => Ok(Action::Cleanup(CleanupAction::Grade)),
        "fix" => Ok(Action::Cleanup(CleanupAction::Fix)),
        other => Err(format!(
            "Unknown cleanup subcommand: {other}. Expected one of: scan, grade, fix"
        )),
    }
}

fn parse_observability(args: &[String]) -> Result<Action, String> {
    let Some(subcommand) = args.get(1).map(String::as_str) else {
        return Err("Usage: harnesscli observability <start|stop|query> [args...]".to_string());
    };

    match subcommand {
        "start" => Ok(Action::Observability(ObservabilityAction::Start)),
        "stop" => Ok(Action::Observability(ObservabilityAction::Stop)),
        "query" => {
            let Some(kind) = args.get(2).map(String::as_str) else {
                return Err(
                    "Usage: harnesscli observability query <logs|metrics|traces> <query>"
                        .to_string(),
                );
            };
            if args.len() < 4 {
                return Err(
                    "Usage: harnesscli observability query <logs|metrics|traces> <query>"
                        .to_string(),
                );
            }
            let kind = match kind {
                "logs" => QueryKind::Logs,
                "metrics" => QueryKind::Metrics,
                "traces" => QueryKind::Traces,
                other => {
                    return Err(format!(
                    "Unknown observability query kind: {other}. Expected logs, metrics, or traces"
                ))
                }
            };
            Ok(Action::Observability(ObservabilityAction::Query {
                kind,
                query: args[3..].join(" "),
            }))
        }
        other => Err(format!(
            "Unknown observability subcommand: {other}. Expected one of: start, stop, query"
        )),
    }
}

pub fn print_help() {
    println!(
        "\
harnesscli commands:
  boot                           Boot the current worktree app
  stop                           Stop the current worktree app
  example                        Print the agent-browser validation flow
  smoke                          Run the harness smoke checks
  test                           Run the harness test suite
  lint                           Run the harness lint checks
  typecheck                      Run the harness typecheck checks
  audit [path]                   Verify harness-required files and directories
  cleanup scan [--fail-on-error] Scan cleanup violations as JSON
  cleanup grade                  Compute the cleanup quality grade
  cleanup fix                    Generate cleanup fix branches and PRs
  observability start            Start the observability stack
  observability stop             Stop the observability stack
  observability query <kind> <query>
                                 Query logs, metrics, or traces

Use `cargo run --manifest-path harness/Cargo.toml -- <command>` when the release binary is not built yet."
    );
}

#[cfg(test)]
mod tests {
    use super::{parse_action, Action, CleanupAction, ObservabilityAction, QueryKind};
    use std::path::PathBuf;

    fn parse(args: &[&str]) -> Action {
        let args = args
            .iter()
            .map(|value| value.to_string())
            .collect::<Vec<_>>();
        parse_action(&args).expect("expected valid action")
    }

    #[test]
    fn parses_core_commands() {
        assert_eq!(parse(&["boot"]), Action::Boot);
        assert_eq!(parse(&["stop"]), Action::Stop);
        assert_eq!(parse(&["example"]), Action::Example);
        assert_eq!(parse(&["smoke"]), Action::Smoke);
        assert_eq!(parse(&["test"]), Action::Test);
        assert_eq!(parse(&["lint"]), Action::Lint);
        assert_eq!(parse(&["typecheck"]), Action::Typecheck);
    }

    #[test]
    fn parses_audit() {
        assert_eq!(
            parse(&["audit", "repo"]),
            Action::Audit {
                target: PathBuf::from("repo"),
            }
        );
    }

    #[test]
    fn parses_cleanup() {
        assert_eq!(
            parse(&["cleanup", "scan", "--fail-on-error"]),
            Action::Cleanup(CleanupAction::Scan {
                fail_on_error: true,
            })
        );
        assert_eq!(
            parse(&["cleanup", "grade"]),
            Action::Cleanup(CleanupAction::Grade)
        );
        assert_eq!(
            parse(&["cleanup", "fix"]),
            Action::Cleanup(CleanupAction::Fix)
        );
    }

    #[test]
    fn parses_observability() {
        assert_eq!(
            parse(&["observability", "start"]),
            Action::Observability(ObservabilityAction::Start)
        );
        assert_eq!(
            parse(&["observability", "stop"]),
            Action::Observability(ObservabilityAction::Stop)
        );
        assert_eq!(
            parse(&["observability", "query", "logs", "{app=\"site\"}"]),
            Action::Observability(ObservabilityAction::Query {
                kind: QueryKind::Logs,
                query: "{app=\"site\"}".to_string(),
            })
        );
    }
}
