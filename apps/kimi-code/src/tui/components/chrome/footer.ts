/**
 * Footer/status bar — simplified two-line status display.
 *
 * Layout:
 *   Line 1:   {cwd}  ·  {git-branch}
 *   Line 2:   {model}  ·  {tokens}/{max} tokens
 */

import type { Component } from '@earendil-works/pi-tui';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import chalk from 'chalk';

import { currentTheme } from '#/tui/theme';
import type { AppState } from '#/tui/types';
import {
  createGitStatusCache,
  formatGitBadgeBase,
  type GitStatus,
  type GitStatusCache,
} from '#/utils/git/git-status';

const MAX_CWD_SEGMENTS = 3;

function modelDisplayName(state: AppState): string {
  const model = state.availableModels[state.model];
  return model?.displayName ?? model?.model ?? state.model;
}

function shortenCwd(path: string): string {
  if (!path) return path;
  const home = process.env['HOME'] ?? '';
  let work = path;
  if (home && path === home) {
    return '~';
  }
  if (home && path.startsWith(home + '/')) {
    work = '~' + path.slice(home.length);
  }

  const segments = work.split('/').filter((s) => s.length > 0);
  if (segments.length <= MAX_CWD_SEGMENTS) return work;
  const tail = segments.slice(-MAX_CWD_SEGMENTS).join('/');
  return `\u2026/${tail}`;
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatFooterGitBadge(status: GitStatus, colors: ReturnType<typeof currentTheme.palette>): string {
  return chalk.hex(colors.textDim)(status.branch);
}

export class FooterComponent implements Component {
  private state: AppState;
  private readonly onRefresh: () => void;
  private gitCache: GitStatusCache;
  private gitCacheWorkDir: string;

  constructor(state: AppState, onRefresh: () => void = () => {}) {
    this.state = state;
    this.onRefresh = onRefresh;
    this.gitCacheWorkDir = state.workDir;
    this.gitCache = createGitStatusCache(state.workDir, { onChange: this.onRefresh });
  }

  setState(state: AppState): void {
    if (state.workDir !== this.gitCacheWorkDir) {
      this.gitCacheWorkDir = state.workDir;
      this.gitCache = createGitStatusCache(state.workDir, { onChange: this.onRefresh });
    }
    this.state = state;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    const colors = currentTheme.palette;
    const dim = chalk.hex(colors.textDim);
    const text = chalk.hex(colors.text);

    // Line 1: cwd  ·  git-branch
    const cwd = shortenCwd(this.state.workDir);
    const git = this.gitCache.getStatus();
    const branch = git !== null ? git.branch : '';
    const line1Parts: string[] = [];
    if (cwd) line1Parts.push(dim(cwd));
    if (branch) line1Parts.push(dim(branch));
    const line1 = line1Parts.length > 0 ? `  ${line1Parts.join(dim(' · '))}` : '';

    // Line 2: model  ·  tokens / max tokens
    const model = modelDisplayName(this.state);
    const tokens = formatTokenCount(this.state.contextTokens);
    const maxTokens = formatTokenCount(this.state.maxContextTokens);
    const line2 = `  ${text(model)}${dim(' · ')}${dim(tokens)}${dim(' / ')}${dim(maxTokens)}${dim(' tokens')}`;

    return [
      truncateToWidth(line1, safeWidth, '…'),
      truncateToWidth(line2, safeWidth, '…'),
    ];
  }
}
