#!/usr/bin/env bun
/**
 * jarvis CLI — Commander.js entry point.
 *
 * Port of nanobot/cli/commands.py. Every command is implemented in
 * src/cli/commands.ts and imported here for Commander registration.
 */

import { Command } from 'commander'
import {
  cmdAgent,
  cmdServe,
  cmdGateway,
  cmdOnboard,
  cmdStatus,
  cmdChannelsStatus,
  cmdChannelsLogin,
  cmdPluginsList,
  cmdProviderLogin,
} from './cli/commands'

const program = new Command()

program
  .name('jarvis')
  .description('jarvis - Personal AI Assistant')
  .version('0.1.0')

// ──── agent ────
program
  .command('agent')
  .description('Interact with the agent directly')
  .option('-m, --message <msg>', 'Single message mode')
  .option('-s, --session <id>', 'Session ID (format: channel:chatId)', 'cli:direct')
  .option('-c, --config <path>', 'Config file path')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('--no-markdown', 'Disable markdown rendering')
  .action(cmdAgent)

// ──── serve ────
program
  .command('serve')
  .description('Start OpenAI-compatible API server')
  .option('-p, --port <n>', 'API server port')
  .option('-H, --host <addr>', 'Bind address')
  .option('-t, --timeout <n>', 'Request timeout (seconds)')
  .option('-v, --verbose', 'Verbose output')
  .option('-c, --config <path>', 'Config file path')
  .option('-w, --workspace <path>', 'Workspace directory')
  .action(cmdServe)

// ──── gateway ────
program
  .command('gateway')
  .description('Start the gateway')
  .option('-p, --port <n>', 'Gateway port')
  .option('-c, --config <path>', 'Config file path')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('-v, --verbose', 'Verbose output')
  .action(cmdGateway)

// ──── onboard ────
program
  .command('onboard')
  .description('Initialize config and workspace')
  .option('-w, --workspace <path>', 'Workspace directory')
  .option('-c, --config <path>', 'Config file path')
  .option('--wizard', 'Use interactive configuration wizard')
  .action(cmdOnboard)

// ──── status ────
program
  .command('status')
  .description('Show jarvis configuration status')
  .option('-c, --config <path>', 'Config file path')
  .action(cmdStatus)

// ──── channels ────
const channelsCmd = program
  .command('channels')
  .description('Manage chat channels')

channelsCmd
  .command('status')
  .description('Show channel status')
  .option('-c, --config <path>', 'Config file path')
  .action(cmdChannelsStatus)

channelsCmd
  .command('login')
  .description('Authenticate with a channel')
  .argument('<channel>', 'Channel name (e.g. weixin, whatsapp)')
  .option('-f, --force', 'Force re-authentication')
  .option('-c, --config <path>', 'Config file path')
  .action(cmdChannelsLogin)

// ──── plugins ────
const pluginsCmd = program
  .command('plugins')
  .description('Manage channel plugins')

pluginsCmd
  .command('list')
  .description('List all discovered channels')
  .option('-c, --config <path>', 'Config file path')
  .action(cmdPluginsList)

// ──── provider ────
const providerCmd = program
  .command('provider')
  .description('Manage LLM providers')

providerCmd
  .command('login')
  .description('Authenticate with an OAuth provider')
  .argument('<provider>', 'OAuth provider name (e.g. openai-codex, github-copilot)')
  .action(cmdProviderLogin)

// ──── Default: agent if no command given ────
if (process.argv.length <= 2) {
  process.argv.push('agent')
}

program.parse()
