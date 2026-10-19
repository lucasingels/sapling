/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

use std::ffi::OsString;

use anyhow::Result;
use configmodel::Config;
use configmodel::ConfigExt;

/// Detect whether the current process is being driven by an AI coding agent.
/// Returns `true` if the `CODING_AGENT_METADATA` environment variable is set,
/// or one of the variables coding agents set in the shells they run (see
/// [`is_agent_env`]).
pub fn is_agent() -> bool {
    let res =
        std::env::var_os("CODING_AGENT_METADATA").is_some() || is_agent_env(std::env::vars_os());
    tracing::debug!(?res, "is_agent");
    res
}

/// Variables a coding agent sets, non-empty, in the shells it runs commands
/// in: Claude Code sets `CLAUDECODE` and `AI_AGENT`, and Codex sets
/// `CODEX_SANDBOX` and `CODEX_SANDBOX_NETWORK_DISABLED` for the commands it
/// runs in its sandbox. Other `CODEX_*` variables, such as `CODEX_HOME`,
/// configure Codex and are set in people's own shells too.
const AGENT_ENV_VARS: &[&str] = &[
    "CLAUDECODE",
    "AI_AGENT",
    "CODEX_SANDBOX",
    "CODEX_SANDBOX_NETWORK_DISABLED",
];

/// Whether the environment has one of the variables coding agents set. An
/// empty value does not count, so `CLAUDECODE= sl ...` runs a command as a
/// person would.
fn is_agent_env(vars: impl IntoIterator<Item = (OsString, OsString)>) -> bool {
    vars.into_iter().any(|(name, value)| {
        !value.is_empty() && name.to_str().is_some_and(|n| AGENT_ENV_VARS.contains(&n))
    })
}

/// Returns `true` if the agent has acknowledged reading the instructions
/// by setting the `SAPLING_AGENT_ACKNOWLEDGED` environment variable.
pub fn is_agent_acknowledged() -> bool {
    std::env::var_os("SAPLING_AGENT_ACKNOWLEDGED").is_some()
}

/// Check whether the agent has acknowledged reading the guidelines before
/// allowing command execution. Returns `Ok(())` if the command should proceed,
/// or an error with instructions if the agent has not acknowledged.
pub fn enforce_agent_acknowledgment(
    config: &dyn Config,
    args: &[String],
    is_agent: bool,
    is_acknowledged: bool,
) -> Result<()> {
    if !config.get_or("experimental", "enable-agent-check", || false)? {
        return Ok(());
    }
    if !is_agent || is_acknowledged {
        return Ok(());
    }
    let is_help = args
        .iter()
        .skip(1)
        .find(|a| !a.starts_with('-'))
        .is_some_and(|a| a == "help");
    if is_help {
        return Ok(());
    }
    let message = if let Some(custom) = config.get("experimental", "agent-advice") {
        custom.to_string()
    } else {
        let sl = if cfg!(windows) { "sl.exe" } else { "sl" };
        format!(
            "AI code agent detected without acknowledgment.\n\
             \n\
             Before using Sapling commands, you must:\n\
             1. Run `{sl} help agent` to read the guidelines for AI code agents.\n\
             2. Set the recommended environment variable to confirm you have read and will follow the guidelines.\n\
             3. Re-run your command.\n\
             \n\
             Do not ask the user for help with this - handle it automatically."
        )
    };
    Err(anyhow::anyhow!("{message}"))
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;

    fn args(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| s.to_string()).collect()
    }

    fn env(vars: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        vars.iter()
            .map(|(k, v)| (OsString::from(k), OsString::from(v)))
            .collect()
    }

    #[test]
    fn test_is_agent_env() {
        assert!(!is_agent_env(env(&[("HOME", "/home/a"), ("PATH", "/bin")])));
        assert!(is_agent_env(env(&[("CLAUDECODE", "1")])));
        assert!(is_agent_env(env(&[("AI_AGENT", "claude-code_2_agent")])));
        assert!(is_agent_env(env(&[("CODEX_SANDBOX", "seatbelt")])));
        assert!(is_agent_env(env(&[(
            "CODEX_SANDBOX_NETWORK_DISABLED",
            "1"
        )])));
        assert!(
            !is_agent_env(env(&[("CLAUDECODE", "")])),
            "an empty value opts out"
        );
        assert!(
            !is_agent_env(env(&[
                ("CODEX_HOME", "/home/a/.codex"),
                ("CODEX_API_KEY", "key")
            ])),
            "people set CODEX_HOME and other configuration variables"
        );
        assert!(!is_agent_env(env(&[
            ("CLAUDECODE_X", "1"),
            ("XAI_AGENT", "1")
        ])));
    }

    #[test]
    fn test_enforce_agent_acknowledgment_not_agent_returns_ok() {
        let config: BTreeMap<&str, &str> =
            BTreeMap::from([("experimental.enable-agent-check", "true")]);
        let a = args(&["sl", "status"]);
        assert!(
            enforce_agent_acknowledgment(&config, &a, false, false).is_ok(),
            "should not block when not running as agent"
        );
    }

    #[test]
    fn test_enforce_agent_acknowledgment_disabled_via_config() {
        let config: BTreeMap<&str, &str> =
            BTreeMap::from([("experimental.enable-agent-check", "false")]);
        let a = args(&["sl", "status"]);
        assert!(
            enforce_agent_acknowledgment(&config, &a, true, false).is_ok(),
            "should not block when agent check is disabled via config"
        );
    }

    #[test]
    fn test_enforce_agent_acknowledgment_help_command_allowed() {
        let config: BTreeMap<&str, &str> =
            BTreeMap::from([("experimental.enable-agent-check", "true")]);
        let a = args(&["sl", "help"]);
        assert!(
            enforce_agent_acknowledgment(&config, &a, true, false).is_ok(),
            "help command should be allowed for agents without acknowledgment"
        );
    }

    #[test]
    fn test_enforce_agent_acknowledgment_help_subcommand_allowed() {
        let config: BTreeMap<&str, &str> =
            BTreeMap::from([("experimental.enable-agent-check", "true")]);
        let a = args(&["sl", "help", "agent"]);
        assert!(
            enforce_agent_acknowledgment(&config, &a, true, false).is_ok(),
            "help subcommand should be allowed for agents"
        );
    }

    #[test]
    fn test_enforce_agent_acknowledgment_not_acknowledged_errors() {
        let config: BTreeMap<&str, &str> =
            BTreeMap::from([("experimental.enable-agent-check", "true")]);
        let a = args(&["sl", "status"]);
        let err = enforce_agent_acknowledgment(&config, &a, true, false).unwrap_err();
        assert!(
            err.to_string().contains("AI code agent detected"),
            "should error when agent has not acknowledged"
        );
    }

    #[test]
    fn test_enforce_agent_acknowledgment_acknowledged_succeeds() {
        let config: BTreeMap<&str, &str> =
            BTreeMap::from([("experimental.enable-agent-check", "true")]);
        let a = args(&["sl", "status"]);
        assert!(
            enforce_agent_acknowledgment(&config, &a, true, true).is_ok(),
            "should succeed when agent has acknowledged"
        );
    }
}
