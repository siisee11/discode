use crate::cli::CleanupAction;
use crate::harness::{read_json, HarnessContext};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::SystemTime;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

#[derive(Debug, Deserialize)]
struct PrinciplesFile {
    principles: Vec<Principle>,
}

#[derive(Clone, Debug, Deserialize)]
struct Principle {
    id: String,
    severity: String,
    automerge: bool,
    remediation: String,
    detection_kind: String,
}

#[derive(Debug, Deserialize)]
struct ArchitectureRules {
    #[serde(rename = "boundaryValidators")]
    boundary_validators: Vec<BoundaryValidator>,
    conventions: Conventions,
}

#[derive(Debug, Deserialize)]
struct BoundaryValidator {
    file: String,
    #[serde(default)]
    #[serde(rename = "mustContainAll")]
    must_contain_all: Vec<String>,
    #[serde(default)]
    #[serde(rename = "mustContainAny")]
    must_contain_any: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct Conventions {
    #[serde(rename = "maxSourceLines")]
    max_source_lines: usize,
    #[serde(rename = "maxScriptLines")]
    max_script_lines: usize,
    #[serde(rename = "forbidTodoOutsideTests")]
    forbid_todo_outside_tests: bool,
}

#[derive(Clone, Debug, Serialize)]
struct CleanupViolation {
    principle_id: String,
    file: String,
    line: Option<usize>,
    description: String,
    severity: String,
    remediation: String,
}

#[derive(Clone, Debug)]
struct SimpleViolation {
    file: String,
    line: Option<usize>,
    description: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct QualityGrade {
    grade: String,
    score: i32,
    timestamp: String,
    trend: String,
    breakdown: BTreeMap<String, QualityBreakdown>,
    previous: Option<PreviousQualityGrade>,
}

#[derive(Debug, Serialize, Deserialize)]
struct QualityBreakdown {
    violations: usize,
    max_score: i32,
    score: i32,
}

#[derive(Debug, Serialize, Deserialize)]
struct PreviousQualityGrade {
    grade: String,
    score: i32,
    timestamp: String,
}

#[derive(Debug, Serialize)]
struct CleanupSummary {
    total: usize,
    by_severity: BTreeMap<String, usize>,
    by_principle: BTreeMap<String, usize>,
}

#[derive(Debug, Serialize)]
struct CleanupReport {
    timestamp: String,
    violations: Vec<CleanupViolation>,
    summary: CleanupSummary,
}

#[derive(Debug, Serialize)]
struct CleanupFixSummary<'a> {
    principle_id: &'a str,
    violations: usize,
    automerge: bool,
    branch: String,
    remediation: &'a str,
}

pub fn run(context: &HarnessContext, action: CleanupAction) -> Result<i32, String> {
    match action {
        CleanupAction::Scan { fail_on_error } => scan(context, fail_on_error),
        CleanupAction::Grade => grade(context),
        CleanupAction::Fix => fix(context),
    }
}

fn scan(context: &HarnessContext, fail_on_error: bool) -> Result<i32, String> {
    let principles = load_principles(context.repo_root())?;
    let violations = collect_violations(context, &principles)?;
    let mut by_severity = BTreeMap::new();
    let mut by_principle = BTreeMap::new();
    for violation in &violations {
        *by_severity.entry(violation.severity.clone()).or_insert(0) += 1;
        *by_principle
            .entry(violation.principle_id.clone())
            .or_insert(0) += 1;
    }
    let report = CleanupReport {
        timestamp: timestamp_now()?,
        summary: CleanupSummary {
            total: violations.len(),
            by_severity,
            by_principle,
        },
        violations,
    };
    let json = serde_json::to_string_pretty(&report)
        .map_err(|error| format!("Failed to serialize cleanup report: {error}"))?;
    println!("{json}");
    let has_error = report
        .violations
        .iter()
        .any(|violation| violation.severity == "error");
    Ok(if fail_on_error && has_error { 1 } else { 0 })
}

fn grade(context: &HarnessContext) -> Result<i32, String> {
    let output_path = context
        .repo_root()
        .join("docs/generated/quality-grade.json");
    let previous = if output_path.is_file() {
        Some(read_json::<QualityGrade>(&output_path)?)
    } else {
        None
    };
    let principles = load_principles(context.repo_root())?;
    let timestamp = timestamp_now()?;
    let mut breakdown = BTreeMap::new();
    let mut score = 100;

    for principle in &principles {
        let violations = detect_violations(context, principle)?;
        let penalty = if principle.severity == "error" { 20 } else { 5 };
        let max_score = if principle.severity == "error" {
            25
        } else {
            15
        };
        let principle_score = std::cmp::max(0, max_score - violations.len() as i32 * penalty);
        breakdown.insert(
            principle.id.clone(),
            QualityBreakdown {
                violations: violations.len(),
                max_score,
                score: principle_score,
            },
        );
        score -= violations.len() as i32 * penalty;
    }
    score = std::cmp::max(0, score);

    let payload = QualityGrade {
        grade: to_grade(score).to_string(),
        score,
        timestamp,
        trend: match previous.as_ref() {
            None => "new".to_string(),
            Some(previous) if score > previous.score => "improving".to_string(),
            Some(previous) if score < previous.score => "declining".to_string(),
            Some(_) => "steady".to_string(),
        },
        breakdown,
        previous: previous.as_ref().map(|previous| PreviousQualityGrade {
            grade: previous.grade.clone(),
            score: previous.score,
            timestamp: previous.timestamp.clone(),
        }),
    };

    let json = serde_json::to_string_pretty(&payload)
        .map_err(|error| format!("Failed to serialize quality grade: {error}"))?;
    fs::write(&output_path, format!("{json}\n"))
        .map_err(|error| format!("Failed to write {}: {error}", output_path.display()))?;
    println!("{json}");
    Ok(0)
}

fn fix(context: &HarnessContext) -> Result<i32, String> {
    let apply = std::env::var("CLEANUP_APPLY").ok().as_deref() == Some("1");
    let enable_prs = std::env::var("CLEANUP_OPEN_PRS").ok().as_deref() == Some("1");
    let principles = load_principles(context.repo_root())?;
    let mut groups = Vec::new();
    for principle in &principles {
        let violations = detect_violations(context, principle)?;
        if !violations.is_empty() {
            groups.push((principle, violations));
        }
    }

    if groups.is_empty() {
        println!("No cleanup violations found.");
        return Ok(0);
    }

    for (principle, violations) in groups {
        let branch = format!("cleanup/{}", principle.id);
        let summary = CleanupFixSummary {
            principle_id: &principle.id,
            violations: violations.len(),
            automerge: principle.automerge,
            branch: branch.clone(),
            remediation: &principle.remediation,
        };
        let json = serde_json::to_string(&summary)
            .map_err(|error| format!("Failed to serialize cleanup fix summary: {error}"))?;
        println!("{json}");

        if !apply {
            continue;
        }

        run_command(
            context.repo_root(),
            "git",
            &["checkout", "-b", &branch],
            true,
        )?;

        if enable_prs {
            let body = format!(
                "Principle: {}\nViolations: {}\n\n{}",
                principle.id,
                violations.len(),
                principle.remediation
            );
            run_command(
                context.repo_root(),
                "gh",
                &[
                    "pr",
                    "create",
                    "--title",
                    &format!("cleanup({}): resolve detected violations", principle.id),
                    "--body",
                    &body,
                    "--label",
                    "cleanup",
                ],
                true,
            )?;
        }
    }

    Ok(0)
}

fn collect_violations(
    context: &HarnessContext,
    principles: &[Principle],
) -> Result<Vec<CleanupViolation>, String> {
    let mut violations = Vec::new();
    for principle in principles {
        for violation in detect_violations(context, principle)? {
            violations.push(CleanupViolation {
                principle_id: principle.id.clone(),
                file: violation.file,
                line: violation.line,
                description: violation.description,
                severity: principle.severity.clone(),
                remediation: principle.remediation.clone(),
            });
        }
    }
    Ok(violations)
}

fn detect_violations(
    context: &HarnessContext,
    principle: &Principle,
) -> Result<Vec<SimpleViolation>, String> {
    match principle.detection_kind.as_str() {
        "boundary-lint" => scan_boundary_violations(context),
        "secret-scan" => scan_secret_violations(context),
        "todo-scan" => scan_todo_violations(context),
        "shell-strict" => scan_shell_strict_violations(context),
        "file-size" => scan_file_size_violations(context),
        _ => Ok(Vec::new()),
    }
}

fn load_principles(repo_root: &Path) -> Result<Vec<Principle>, String> {
    let path = repo_root.join("golden-principles.yaml");
    let content = fs::read_to_string(&path)
        .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
    let file: PrinciplesFile = serde_yaml::from_str(&content)
        .map_err(|error| format!("Failed to parse {}: {error}", path.display()))?;
    Ok(file.principles)
}

fn load_architecture_rules(repo_root: &Path) -> Result<ArchitectureRules, String> {
    read_json(&repo_root.join("docs/generated/architecture-rules.json"))
}

fn scan_boundary_violations(context: &HarnessContext) -> Result<Vec<SimpleViolation>, String> {
    let rules = load_architecture_rules(context.repo_root())?;
    let mut violations = Vec::new();
    for rule in rules.boundary_validators {
        let path = context.repo_root().join(&rule.file);
        let content = fs::read_to_string(&path)
            .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
        let missing_all = rule
            .must_contain_all
            .iter()
            .filter(|token| !content.contains(token.as_str()))
            .count();
        let has_any = if rule.must_contain_any.is_empty() {
            true
        } else {
            rule.must_contain_any
                .iter()
                .any(|token| content.contains(token.as_str()))
        };
        if missing_all > 0 || !has_any {
            violations.push(SimpleViolation {
                file: rule.file,
                line: None,
                description: format!(
                    "{} is missing the required boundary parsing guard.",
                    path.strip_prefix(context.repo_root())
                        .unwrap_or(&path)
                        .display()
                ),
            });
        }
    }
    Ok(violations)
}

fn scan_secret_violations(context: &HarnessContext) -> Result<Vec<SimpleViolation>, String> {
    let files = collect_convention_files(context.repo_root())?;
    let patterns = [
        Regex::new(r"\bghp_[A-Za-z0-9]{20,}\b").expect("valid regex"),
        Regex::new(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b").expect("valid regex"),
        Regex::new(r"\bAKIA[0-9A-Z]{16}\b").expect("valid regex"),
        Regex::new(r"\bsk_live_[A-Za-z0-9]{10,}\b").expect("valid regex"),
    ];
    let mut violations = Vec::new();

    for path in files {
        let repo_path = to_repo_path(context.repo_root(), &path);
        if repo_path.starts_with("tests/")
            || repo_path.starts_with("docs/")
            || repo_path.starts_with(".worktree/")
        {
            continue;
        }
        let content = fs::read_to_string(&path)
            .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
        for (index, line) in content.lines().enumerate() {
            let sanitizer_example = line.contains("TOKEN_PREFIXES")
                || line.contains("maskToken(")
                || line.contains("prefix +")
                || line.contains("***");
            if !sanitizer_example && patterns.iter().any(|pattern| pattern.is_match(line)) {
                violations.push(SimpleViolation {
                    file: repo_path.clone(),
                    line: Some(index + 1),
                    description: "Found token-shaped secret material.".to_string(),
                });
            }
        }
    }

    Ok(violations)
}

fn scan_todo_violations(context: &HarnessContext) -> Result<Vec<SimpleViolation>, String> {
    let rules = load_architecture_rules(context.repo_root())?;
    if !rules.conventions.forbid_todo_outside_tests {
        return Ok(Vec::new());
    }
    let markdown_re = Regex::new(r"(?m)^\s*(TODO|FIXME|XXX)\b").expect("valid regex");
    let code_re = Regex::new(r"(?m)^\s*(//|#|/\*+|\*)\s*(TODO|FIXME|XXX)\b").expect("valid regex");
    let mut violations = Vec::new();

    for path in collect_convention_files(context.repo_root())? {
        let repo_path = to_repo_path(context.repo_root(), &path);
        if repo_path.starts_with("tests/") {
            continue;
        }
        let content = fs::read_to_string(&path)
            .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
        let has_todo = if repo_path.ends_with(".md") {
            markdown_re.is_match(&content)
        } else {
            code_re.is_match(&content)
        };
        if has_todo {
            violations.push(SimpleViolation {
                file: repo_path,
                line: None,
                description: "Found TODO-style placeholder.".to_string(),
            });
        }
    }
    Ok(violations)
}

fn scan_shell_strict_violations(context: &HarnessContext) -> Result<Vec<SimpleViolation>, String> {
    let mut violations = Vec::new();
    for path in collect_convention_files(context.repo_root())? {
        let repo_path = to_repo_path(context.repo_root(), &path);
        let is_target = repo_path.ends_with(".sh")
            && (repo_path.starts_with("scripts/harness/")
                || repo_path.starts_with("scripts/observability/")
                || repo_path.starts_with("scripts/cleanup/"));
        if !is_target {
            continue;
        }
        let content = fs::read_to_string(&path)
            .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
        if !content.contains("set -euo pipefail") {
            violations.push(SimpleViolation {
                file: repo_path,
                line: None,
                description: "Harness shell script is missing strict mode.".to_string(),
            });
        }
    }
    Ok(violations)
}

fn scan_file_size_violations(context: &HarnessContext) -> Result<Vec<SimpleViolation>, String> {
    let rules = load_architecture_rules(context.repo_root())?;
    let mut violations = Vec::new();
    for path in collect_convention_files(context.repo_root())? {
        let repo_path = to_repo_path(context.repo_root(), &path);
        let content = fs::read_to_string(&path)
            .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
        let line_count = content.lines().count();
        if repo_path.starts_with("src/")
            && path.extension().and_then(|value| value.to_str()) == Some("ts")
            && line_count > rules.conventions.max_source_lines
        {
            violations.push(SimpleViolation {
                file: repo_path.clone(),
                line: None,
                description: "File exceeds the configured harness size limit.".to_string(),
            });
        }
        if repo_path.starts_with("scripts/") && line_count > rules.conventions.max_script_lines {
            violations.push(SimpleViolation {
                file: repo_path,
                line: None,
                description: "File exceeds the configured harness size limit.".to_string(),
            });
        }
    }
    Ok(violations)
}

fn collect_convention_files(repo_root: &Path) -> Result<Vec<PathBuf>, String> {
    walk_files(repo_root, &|path| {
        let repo_path = to_repo_path(repo_root, path);
        let owned = repo_path.starts_with("src/")
            || repo_path.starts_with("bin/")
            || repo_path.starts_with("scripts/")
            || repo_path.starts_with("docs/")
            || repo_path.starts_with("site/")
            || repo_path.starts_with("workers/telemetry-proxy/src/")
            || repo_path.starts_with("tests/");
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        owned && matches!(extension, "ts" | "tsx" | "js" | "mjs" | "cjs" | "sh" | "md")
    })
}

fn walk_files(root: &Path, predicate: &dyn Fn(&Path) -> bool) -> Result<Vec<PathBuf>, String> {
    let mut results = Vec::new();
    visit_directory(root, root, predicate, &mut results)?;
    Ok(results)
}

fn visit_directory(
    repo_root: &Path,
    current: &Path,
    predicate: &dyn Fn(&Path) -> bool,
    results: &mut Vec<PathBuf>,
) -> Result<(), String> {
    let entries = fs::read_dir(current)
        .map_err(|error| format!("Failed to read directory {}: {error}", current.display()))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("Failed to read directory entry: {error}"))?;
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name == "node_modules" || name == "dist" || name == ".git" || name == ".worktree" {
            continue;
        }
        if path.is_dir() {
            visit_directory(repo_root, &path, predicate, results)?;
        } else if predicate(&path) {
            let canonical = if path.is_absolute() {
                path
            } else {
                repo_root.join(path)
            };
            results.push(canonical);
        }
    }
    Ok(())
}

fn to_repo_path(repo_root: &Path, path: &Path) -> String {
    path.strip_prefix(repo_root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn to_grade(score: i32) -> &'static str {
    if score >= 97 {
        "A+"
    } else if score >= 93 {
        "A"
    } else if score >= 90 {
        "A-"
    } else if score >= 87 {
        "B+"
    } else if score >= 83 {
        "B"
    } else if score >= 80 {
        "B-"
    } else if score >= 77 {
        "C+"
    } else if score >= 73 {
        "C"
    } else if score >= 70 {
        "C-"
    } else {
        "D"
    }
}

fn run_command(repo_root: &Path, program: &str, args: &[&str], echo: bool) -> Result<(), String> {
    if echo {
        println!("+ {} {}", program, args.join(" "));
    }
    let status = Command::new(program)
        .args(args)
        .current_dir(repo_root)
        .status()
        .map_err(|error| format!("Failed to run {program}: {error}"))?;
    if !status.success() {
        return Err(format!(
            "Command failed with exit code {}: {} {}",
            status.code().unwrap_or(1),
            program,
            args.join(" ")
        ));
    }
    Ok(())
}

fn timestamp_now() -> Result<String, String> {
    OffsetDateTime::from(SystemTime::now())
        .format(&Rfc3339)
        .map_err(|error| format!("Failed to format UTC timestamp: {error}"))
}
