import agentYaml from './default/agent.yaml?raw';
import coderYaml from './default/coder.yaml?raw';
import exploreYaml from './default/explore.yaml?raw';
import initMd from './default/init.md?raw';
import planYaml from './default/plan.yaml?raw';
import localSystemMd from './default/local-system.md?raw';
import systemMd from './default/system.md?raw';
import { loadAgentProfilesFromSources } from './load';

// Keyed by the source path the profile loader expects: profile YAML files
// plus any file referenced through `systemPromptPath`.
const PROFILE_SOURCES: Record<string, string> = {
  'profile/default/agent.yaml': agentYaml,
  'profile/default/coder.yaml': coderYaml,
  'profile/default/explore.yaml': exploreYaml,
  'profile/default/plan.yaml': planYaml,
  'profile/default/system.md': systemMd,
  'profile/default/local-system.md': localSystemMd,
};

export const DEFAULT_INIT_PROMPT = initMd;

export const DEFAULT_AGENT_PROFILES = loadAgentProfilesFromSources(
  ['agent.yaml', 'coder.yaml', 'explore.yaml', 'plan.yaml'].map(
    (file) => `profile/default/${file}`,
  ),
  PROFILE_SOURCES,
);

/** Agent profiles for local models — uses a lite system prompt (~250 tokens). */
const LOCAL_AGENT_YAML = agentYaml.replace(
  'systemPromptPath: ./system.md',
  'systemPromptPath: ./local-system.md',
);

export const LOCAL_AGENT_PROFILES = loadAgentProfilesFromSources(
  ['agent.yaml', 'coder.yaml', 'explore.yaml', 'plan.yaml'].map(
    (file) => `profile/default/${file}`,
  ),
  { ...PROFILE_SOURCES, 'profile/default/agent.yaml': LOCAL_AGENT_YAML },
);

