mod cleanup;
mod cli;
mod harness;

use crate::cli::{parse_action, Action};
use crate::harness::HarnessContext;
use std::process;

fn main() {
    let context = match HarnessContext::discover() {
        Ok(context) => context,
        Err(message) => {
            eprintln!("{message}");
            process::exit(1);
        }
    };

    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let action = match parse_action(&args) {
        Ok(action) => action,
        Err(message) => {
            eprintln!("{message}");
            cli::print_help();
            process::exit(2);
        }
    };

    let exit_code = match dispatch(&context, action) {
        Ok(exit_code) => exit_code,
        Err(message) => {
            eprintln!("{message}");
            1
        }
    };

    process::exit(exit_code);
}

fn dispatch(context: &HarnessContext, action: Action) -> Result<i32, String> {
    match action {
        Action::Help => {
            cli::print_help();
            Ok(0)
        }
        Action::Boot => harness::boot(context),
        Action::Stop => harness::stop(context),
        Action::Example => harness::example(context),
        Action::Smoke => harness::smoke(context),
        Action::Test => harness::test(context),
        Action::Lint => harness::lint(context),
        Action::Typecheck => harness::typecheck(context),
        Action::Audit { target } => harness::audit(context, &target),
        Action::Cleanup(action) => cleanup::run(context, action),
        Action::Observability(action) => harness::run_observability(context, action),
    }
}
