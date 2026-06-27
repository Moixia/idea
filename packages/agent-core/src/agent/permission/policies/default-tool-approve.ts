import picomatch from 'picomatch';

import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';

const DEFAULT_APPROVE_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'ReadMediaFile',
  'SetTodoList',
  'TodoList',
  'TaskList',
  'TaskOutput',
  'CronList',
  'WebSearch',
  'FetchURL',
  'Agent',
  'AskUserQuestion',
  'Skill',
  // Goal control tools have no side effects on the world: GetGoal reads, and
  // mutation tools only record the goal's own runtime state.
  'GetGoal',
  'SetGoalBudget',
  'UpdateGoal',
]);

const DEFAULT_APPROVE_GLOB_PATTERNS: readonly string[] = [
  // All tools from the "lander" MCP server are read-only queries.
  'mcp__lander__*',
];

export class DefaultToolApprovePermissionPolicy implements PermissionPolicy {
  readonly name = 'default-tool-approve';

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    if (DEFAULT_APPROVE_TOOLS.has(context.toolCall.name)) {
      return { kind: 'approve' };
    }
    if (DEFAULT_APPROVE_GLOB_PATTERNS.some((pattern) => picomatch.isMatch(context.toolCall.name, pattern))) {
      return { kind: 'approve' };
    }
    return;
  }
}
