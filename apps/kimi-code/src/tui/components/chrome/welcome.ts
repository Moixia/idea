/**
 * Welcome panel shown at the top of the TUI.
 * Renders a single clean line with version, model, and MCP summary.
 */

import type { Component } from '@earendil-works/pi-tui';
import { truncateToWidth } from '@earendil-works/pi-tui';
import chalk from 'chalk';

import type { AppState } from '#/tui/types';
import { currentTheme } from '#/tui/theme';

export class WelcomeComponent implements Component {
  private state: AppState;

  constructor(state: AppState) {
    this.state = state;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    const dim = chalk.hex(currentTheme.palette.textDim);
    const primary = chalk.hex(currentTheme.palette.primary);

    const activeModel = this.state.availableModels[this.state.model];
    const modelValue = activeModel?.displayName ?? activeModel?.model ?? this.state.model;

    const parts: string[] = [
      `Landa ${this.state.version}`,
      modelValue,
    ];

    if (this.state.mcpServersSummary) {
      parts.push(this.state.mcpServersSummary);
    }

    const line = `  ${parts.join(dim(' · '))}`;
    return ['', truncateToWidth(line, safeWidth, '…')];
  }
}
