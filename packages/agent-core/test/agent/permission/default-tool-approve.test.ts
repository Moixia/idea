import type { ToolCall } from '@moonshot-ai/kosong';
import { describe, expect, it } from 'vitest';

import type { PermissionPolicyContext } from '../../../src/agent/permission';
import { DefaultToolApprovePermissionPolicy } from '../../../src/agent/permission/policies/default-tool-approve';
import { ToolAccesses } from '../../../src/loop';

const signal = new AbortController().signal;

function policyContext(toolName: string, args: unknown): PermissionPolicyContext {
  return {
    turnId: '0',
    stepNumber: 1,
    signal,
    llm: {},
    args,
    toolCall: {
      type: 'function',
      id: `call_${toolName}`,
      name: toolName,
      arguments: JSON.stringify(args),
    } satisfies ToolCall,
    toolCalls: [
      {
        type: 'function',
        id: `call_${toolName}`,
        name: toolName,
        arguments: JSON.stringify(args),
      },
    ],
    execution: {
      accesses: ToolAccesses.none(),
      approvalRule: toolName,
      execute: async () => ({ output: '' }),
    },
  } as unknown as PermissionPolicyContext;
}

describe('DefaultToolApprovePermissionPolicy', () => {
  const policy = new DefaultToolApprovePermissionPolicy();

  it('auto-approves CronList', () => {
    expect(policy.evaluate(policyContext('CronList', {}))).toEqual({ kind: 'approve' });
  });

  it('does not approve CronCreate', () => {
    expect(
      policy.evaluate(policyContext('CronCreate', { cron: '*/5 * * * *', prompt: 'ping' })),
    ).toBeUndefined();
  });

  it('does not approve CronDelete', () => {
    expect(policy.evaluate(policyContext('CronDelete', { id: 'job_1' }))).toBeUndefined();
  });

  it('does not approve AgentSwarm', () => {
    expect(
      policy.evaluate(
        policyContext('AgentSwarm', {
          description: 'Check files',
          prompt_template: 'Check {{item}}',
          items: ['a.ts', 'b.ts'],
        }),
      ),
    ).toBeUndefined();
  });

  it('auto-approves all MCP tools from lander server', () => {
    expect(policy.evaluate(policyContext('mcp__lander__query', {}))).toEqual({ kind: 'approve' });
    expect(policy.evaluate(policyContext('mcp__lander__search', {}))).toEqual({ kind: 'approve' });
    expect(policy.evaluate(policyContext('mcp__lander__read', {}))).toEqual({ kind: 'approve' });
  });

  it('does not auto-approve MCP tools from other servers', () => {
    expect(policy.evaluate(policyContext('mcp__github__listPRs', {}))).toBeUndefined();
    expect(policy.evaluate(policyContext('mcp__filesystem__write', {}))).toBeUndefined();
  });
});
