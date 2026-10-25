/**
 * AUTO-GENERATED FROM core/asyncapi.yaml. DO NOT EDIT MANUALLY.
 *
 * Run `npm run asyncapi:generate` to regenerate.
 *
 * Source of truth: the yaml at core/asyncapi.yaml.
 * Editors and clients in any language can consume the spec directly.
 */

export type ServerMessage =
  | ProviderCapabilities
  | AgentCreated
  | AgentClosed
  | AgentSelected
  | ExistingAgents
  | AgentStatus
  | AgentToolStart
  | AgentToolDone
  | AgentToolsClear
  | AgentToolPermission
  | AgentToolPermissionClear
  | SubagentToolStart
  | SubagentToolDone
  | SubagentClear
  | SubagentToolPermission
  | AgentTeamInfo
  | AgentContextUsage
  | LayoutLoaded
  | FurnitureAssetsLoaded
  | CharacterSpritesLoaded
  | PetSpritesLoaded
  | FloorTilesLoaded
  | WallTilesLoaded
  | CarpetTilesLoaded
  | OfficeAccess
  | SettingsLoaded
  | BypassPermissionsUpdated
  | HooksStatus
  | HooksConsentRequest
  | ExternalAssetDirectoriesUpdated
  | AreaMappingsLoaded
  | DirectoriesLoaded
  | DirectorySaved
  | DirectoryRejected
  | DirectorySuggestions
  | TerminalAvailability
  | TerminalSessionOpened
  | TerminalSessionClosed
  | AgentDiagnostics
  | CharacterPresets
  | CharacterRefused
  | CharacterParts
  | DeviceApprovalRequest
  | DeviceApprovalClosed
  | NewDeviceLogin
  | ShellNotice
  | RepoState
  | RepoDiff
  | RepoWorktreeDetail
  | RepoActionResult
  | OfficeSnapshot
  | CodexTasks
  | TempStaff
  | OfficeJobs
  | HwSample
  | UsageState
  | CodexUsageCheckResult
  | AgentRules
  | NewAgentPermission
  | GpuBoard
  | OfficeEvent
  | StatusOutput
  | ChatTranscript
  | ChatHistoryResult
  | ChatSearchResult
  | WorkContent
  | ChatSendResult
  | ChatPendingResult
  | PermissionAnswerResult
  | SlashCommandsList
  | MessengerContacts
  | GroupRooms
  | GroupTimeline
  | GroupActionResult
  | EzRules
  | EngineState
  | EngineActionResult
  | ProjectScanResult
  | ProjectImportResult
  | ProjectImportSuggestion
  | JobActionResult
  | ViewerVisibilityAck
  | BuildingState
  | HostInfo
  | FolderList
  | PushState
  | WhiteboardMemos
  | PinnedConversations
  | TaskBoard
  | DelegationApprovals
  | TrackedItems
  | TrackingSources;

export type ClientMessage =
  | WebviewReady
  | LaunchAgent
  | FocusAgent
  | CloseAgent
  | SaveAgentSeats
  | SaveLayout
  | SetSoundEnabled
  | SetLastSeenVersion
  | SetAlwaysShowLabels
  | SetGhostHeadlessAgents
  | SetHooksEnabled
  | HooksConsentResponse
  | SetHooksInfoShown
  | SetWatchAllSessions
  | ExportLayout
  | ImportLayout
  | OpenSessionsFolder
  | AddExternalAssetDirectory
  | RemoveExternalAssetDirectory
  | SaveAreaMappings
  | SetShowAreas
  | SetBypassPermissions
  | SetShowHostDirectories
  | SaveDirectory
  | RemoveDirectory
  | RequestDirectorySuggestions
  | RequestDiagnostics
  | SetCharacter
  | RepoView
  | RepoDiffRequest
  | RepoWorktreeRequest
  | RepoAction
  | StatusView
  | ChatView
  | ChatHistory
  | ChatSearch
  | WorkView
  | ChatSend
  | ChatSendNow
  | ChatCancel
  | ChatEdit
  | ChatHold
  | PermissionAnswer
  | GroupView
  | GroupPost
  | GroupAction
  | SlashCommands
  | EngineAction
  | EngineChoicesRefresh
  | ProjectScan
  | ProjectImport
  | ProjectImportUndo
  | ProjectImportDismiss
  | JobAction
  | ViewerVisibility
  | HwView
  | AddFloor
  | RenameFloor
  | RemoveFloor
  | MoveToFloor
  | SetFloorRule
  | ResetRoomDecor
  | ListFolders
  | PushSubscribe
  | PushUnsubscribe
  | SetWhiteboardMemo
  | SetConversationPin
  | TaskEdit
  | CodexUsageCheck
  | AgentRulesRequest
  | NewAgentPermissionRequest
  | DelegationDecision
  | TrackingSettings;

export interface ProviderCapabilities {
  type: 'providerCapabilities';
  readingTools: string[];
  subagentToolNames: string[];
}

export interface AgentCreated {
  type: 'agentCreated';
  id: number;
  directoryName?: string;
  isExternal?: boolean;
  palette?: number;
  hueShift?: number;
}

export interface AgentClosed {
  type: 'agentClosed';
  id: number;
}

export interface AgentSelected {
  type: 'agentSelected';
  id: number;
}

export interface ExistingAgents {
  type: 'existingAgents';
  agents: number[];
  agentMeta: Record<string, AgentSeatMeta>;
  directoryNames: Record<string, string>;
  externalAgents: Record<string, boolean>;
}

export interface AgentSeatMeta {
  palette?: number;
  hueShift?: number;
  seatId?: string;
}

export interface AgentStatus {
  type: 'agentStatus';
  id: number;
  status: AgentActivityStatus;
  awaitingInput?: boolean;
}

export type AgentActivityStatus = 'active' | 'waiting';

export interface AgentToolStart {
  type: 'agentToolStart';
  id: number;
  toolId: string;
  status: string;
  toolName?: string;
  desc?: string;
  permissionActive?: boolean;
  runInBackground?: boolean;
  isTeammateSpawn?: boolean;
  model?: string;
}

export interface AgentToolDone {
  type: 'agentToolDone';
  id: number;
  toolId: string;
}

export interface AgentToolsClear {
  type: 'agentToolsClear';
  id: number;
}

export interface AgentToolPermission {
  type: 'agentToolPermission';
  id: number;
  asker?: string;
}

export interface AgentToolPermissionClear {
  type: 'agentToolPermissionClear';
  id: number;
}

export interface SubagentToolStart {
  type: 'subagentToolStart';
  id: number;
  parentToolId: string;
  toolId: string;
  status: string;
  desc?: string;
  model?: string;
}

export interface SubagentToolDone {
  type: 'subagentToolDone';
  id: number;
  parentToolId: string;
  toolId: string;
}

export interface SubagentClear {
  type: 'subagentClear';
  id: number;
  parentToolId: string;
}

export interface SubagentToolPermission {
  type: 'subagentToolPermission';
  id: number;
  parentToolId: string;
}

export interface AgentTeamInfo {
  type: 'agentTeamInfo';
  id: number;
  teamName?: string;
  agentName?: string;
  isTeamLead?: boolean;
  leadAgentId?: number;
  teamUsesTmux?: boolean;
}

export interface AgentContextUsage {
  type: 'agentContextUsage';
  id: number;
  contextTokens: number;
  maxContextTokens: number;
}

export interface LayoutLoaded {
  type: 'layoutLoaded';
  layout: Record<string, any> | null;
  wasReset?: boolean;
}

export interface FurnitureAssetsLoaded {
  type: 'furnitureAssetsLoaded';
  catalog: FurnitureAssetMessage[];
  sprites: Record<string, string[][]>;
}

export interface FurnitureAssetMessage {
  id: string;
  name: string;
  label: string;
  category: string;
  file: string;
  width: number;
  height: number;
  footprintW: number;
  footprintH: number;
  isDesk: boolean;
  canPlaceOnWalls: boolean;
  groupId?: string;
  canPlaceOnSurfaces?: boolean;
  backgroundTiles?: number;
  orientation?: string;
  state?: string;
  mirrorSide?: boolean;
  rotationScheme?: string;
  animationGroup?: string;
  frame?: number;
  visual?: FurnitureVisual;
}

export interface FurnitureVisual {
  footAnchor?: FurnitureFootAnchor;
  elevation?: number;
  depthOffset?: number;
  occlusionMode?: FurnitureOcclusionMode;
  shadowPreset?: string;
  lightingPreset?: string;
}

export interface FurnitureFootAnchor {
  x: number;
  y: number;
}

export type FurnitureOcclusionMode = 'default' | 'foreground';

export interface CharacterSpritesLoaded {
  type: 'characterSpritesLoaded';
  characters: CharacterSpriteSet[];
}

export interface CharacterSpriteSet {
  down: string[][][];
  up: string[][][];
  right: string[][][];
}

export interface PetSpritesLoaded {
  type: 'petSpritesLoaded';
  pets: PetSpriteFrameSet[];
  petNames: string[];
}

export interface PetSpriteFrameSet {
  walkDown: string[][][];
  idleDown: string[][][];
  walkUp: string[][][];
  idleUp: string[][][];
  walkRight: string[][][];
}

export interface FloorTilesLoaded {
  type: 'floorTilesLoaded';
  sprites: string[][][];
}

export interface WallTilesLoaded {
  type: 'wallTilesLoaded';
  sets: string[][][][];
}

export interface CarpetTilesLoaded {
  type: 'carpetTilesLoaded';
  sets: string[][][][];
}

export interface OfficeAccess {
  type: 'officeAccess';
  readOnly: boolean;
  terminal?: boolean;
  webBuild?: string;
}

export interface SettingsLoaded {
  type: 'settingsLoaded';
  soundEnabled: boolean;
  lastSeenVersion: string;
  extensionVersion: string;
  watchAllSessions: boolean;
  alwaysShowLabels: boolean;
  ghostHeadlessAgents: boolean;
  hooksEnabled: boolean;
  hooksInfoShown: boolean;
  externalAssetDirectories: string[];
  showAreas: boolean;
  bypassPermissions: boolean;
  showHostDirectories: boolean;
}

export interface BypassPermissionsUpdated {
  type: 'bypassPermissionsUpdated';
  enabled: boolean;
}

export interface HooksStatus {
  type: 'hooksStatus';
  providerId: string;
  installed: boolean;
}

export interface HooksConsentRequest {
  type: 'hooksConsentRequest';
  providerId: string;
  headline: string;
  disclosure: string;
}

export interface ExternalAssetDirectoriesUpdated {
  type: 'externalAssetDirectoriesUpdated';
  dirs: string[];
}

export interface AreaMappingsLoaded {
  type: 'areaMappingsLoaded';
  mappings: Record<string, string[]>;
}

export interface DirectoriesLoaded {
  type: 'directoriesLoaded';
  directories: Directory[];
}

export interface Directory {
  name: string;
  path: string;
  source: DirectorySource;
}

export type DirectorySource = 'user' | 'host';

export interface DirectorySaved {
  type: 'directorySaved';
  directory: Directory;
}

export interface DirectoryRejected {
  type: 'directoryRejected';
  path: string;
  reason: string;
}

export interface DirectorySuggestions {
  type: 'directorySuggestions';
  paths: string[];
}

export interface TerminalAvailability {
  type: 'terminalAvailability';
  available: boolean;
  reason?: string;
}

export interface TerminalSessionOpened {
  type: 'terminalSessionOpened';
  agentId: number;
}

export interface TerminalSessionClosed {
  type: 'terminalSessionClosed';
  agentId: number;
  exitCode?: number;
}

export interface AgentDiagnostics {
  type: 'agentDiagnostics';
  agents: Record<string, any>[];
}

export interface CharacterPresets {
  type: 'characterPresets';
  presets: CharacterPreset[];
  assignments: Record<string, CharacterChoice>;
}

export interface CharacterPreset {
  id: string;
  label: string;
  url: string;
  mugshotUrl: string | null;
  density?: CharacterDensity;
}

export type CharacterDensity = 1 | 2;

export interface CharacterChoice {
  preset?: string;
  palette?: number;
  hueShift?: number;
  v?: number;
  kind?: CharacterKind;
  base?: number;
  hue?: number;
  colors?: CharacterColors;
  acc?: CharacterAccessory[];
  species?: MascotSpecies;
  color?: string;
  expr?: LookExpression;
  gear?: MascotGear;
  sheet?: string;
  gender?: CharacterGender;
  parts?: CharacterWorn;
  body?: CharacterBody;
}

export type CharacterKind = 'humanoid' | 'mascot' | 'custom' | 'person';

export interface CharacterColors {
  hair?: string;
  skin?: string;
  top?: string;
  bottom?: string;
  shoes?: string;
  outer?: string;
  acc?: string;
  legwear?: string;
  fullbody?: string;
  neck?: string;
  wrist?: string;
  back?: string;
}

export type CharacterAccessory = 'glasses' | 'headset' | 'cap';

export type MascotSpecies = 'coral' | 'byte' | 'puff' | 'tori';

export type LookExpression =
  'smile' | 'happy' | 'focus' | 'sleepy' | 'neutral' | 'wink' | 'shy' | 'surprised' | 'playful';

export type MascotGear = 'headset' | 'beanie' | 'sprout' | 'crown';

export type CharacterGender = 'm' | 'f';

export interface CharacterWorn {
  back?: string;
  body?: string;
  face?: string;
  legwear?: string;
  bottom?: string;
  shoes?: string;
  top?: string;
  fullbody?: string;
  outer?: string;
  neck?: string;
  wrist?: string;
  hair?: string;
  acc?: string[];
}

export type CharacterBody = 'standard' | 'slim' | 'curvy' | 'plus';

export interface CharacterRefused {
  type: 'characterRefused';
  key: string;
  reason: CharacterRefusalReason;
}

export type CharacterRefusalReason = 'unknown' | 'invalid' | 'full';

export interface CharacterParts {
  type: 'characterParts';
  packs: CharacterPack[];
  parts: CharacterPart[];
  presets: PersonPreset[];
}

export interface CharacterPack {
  id: string;
  version: number;
  title: LocalText;
  builtIn: boolean;
  characters: PackCharacter[];
  presets: PackPreset[];
}

export interface LocalText {
  ko: string;
  en: string;
}

export interface PackCharacter {
  id: string;
  name: LocalText;
  age?: number;
}

export interface PackPreset {
  id: string;
  character?: string;
  outfit?: string;
  name: LocalText;
  look: CharacterChoice;
}

export interface CharacterPart {
  id: string;
  slot: CharacterPartSlot;
  kind: AnonymousSchema_286;
  gender?: CharacterGender;
  name?: string;
  ramp: string[];
  palette: string[];
  pixels: string;
  hd?: CharacterPartHd;
  expressions?: Record<string, CharacterPartArt>;
  bodies?: CharacterBody[];
  variants?: Record<string, CharacterPartArt>;
  pack?: string;
  label?: LocalText;
}

export type CharacterPartSlot =
  | 'back'
  | 'body'
  | 'face'
  | 'legwear'
  | 'bottom'
  | 'shoes'
  | 'top'
  | 'fullbody'
  | 'outer'
  | 'neck'
  | 'wrist'
  | 'hair'
  | 'acc';

export type AnonymousSchema_286 = 'sheet' | 'head';

export interface CharacterPartHd {
  ramp: string[];
  palette: string[];
  pixels: string;
}

export interface CharacterPartArt {
  palette: string[];
  pixels: string;
  ramp?: string[];
  hd?: CharacterPartHd;
}

export interface PersonPreset {
  name: string;
  look: CharacterChoice;
}

export interface DeviceApprovalRequest {
  type: 'deviceApprovalRequest';
  id: string;
  label: string;
  agent: string;
  ip: string;
  network: ApprovalNetwork;
  createdAt: number;
  expiresAt: number;
}

export type ApprovalNetwork = 'funnel' | 'tailnet' | 'lan' | 'local';

export interface DeviceApprovalClosed {
  type: 'deviceApprovalClosed';
  id: string;
  outcome: ApprovalOutcome;
}

export type ApprovalOutcome = 'approved' | 'refused' | 'expired';

export interface NewDeviceLogin {
  type: 'newDeviceLogin';
  id: string;
  label: string;
  at: number;
}

export interface ShellNotice {
  type: 'shellNotice';
  action: ShellAction;
  id: string;
  deviceId: string;
  label: string;
  at: number;
}

export type ShellAction = 'open' | 'close';

export interface RepoState {
  type: 'repoState';
  project: string;
  ok: boolean;
  error?: string;
  errorCode?: string;
  errorParams?: Record<string, string | number>;
  branch?: string | null;
  head?: string | null;
  upstream?: string | null;
  ahead?: number | null;
  behind?: number | null;
  files?: RepoFile[];
  filesTruncated?: boolean;
  statUnstaged?: string;
  statStaged?: string;
  worktrees?: RepoWorktree[];
  merges?: RepoMerge[];
}

export interface RepoFile {
  path: string;
  origPath?: string;
  index: string;
  worktree: string;
}

export interface RepoWorktree {
  task: string;
  taskId?: string;
  assignmentId?: string;
  assignee?: string;
  createdBy?: string;
  path: string;
  branch: string;
  base: string;
  created: string;
  exists: boolean;
  ahead: number;
  behind: number;
  dirty: number;
  merged: boolean;
  merge?: RepoMerge;
}

export interface RepoMerge {
  task?: string;
  branch?: string;
  ok: boolean;
  at: string;
  target: string;
  auto: boolean;
  kind?: string;
  sha?: string;
  code?: string;
  conflicts?: string[];
  error?: string;
  errorCode?: string;
  errorParams?: Record<string, string | number>;
}

export interface RepoDiff {
  type: 'repoDiff';
  requestId: string;
  project: string;
  task?: string;
  path: string;
  staged: boolean;
  ok: boolean;
  text?: string;
  nextOffset?: number;
  limited?: boolean;
  error?: string;
  errorCode?: string;
  errorParams?: Record<string, string | number>;
}

export interface RepoWorktreeDetail {
  type: 'repoWorktreeDetail';
  requestId: string;
  project: string;
  task: string;
  ok: boolean;
  error?: string;
  errorCode?: string;
  errorParams?: Record<string, string | number>;
  files?: RepoChangedFile[];
  filesTruncated?: boolean;
  commits?: RepoCommit[];
  guard?: string;
}

export interface RepoChangedFile {
  path: string;
  origPath?: string;
  status: string;
}

export interface RepoCommit {
  sha: string;
  subject: string;
  author: string;
  at: string;
}

export interface RepoActionResult {
  type: 'repoActionResult';
  requestId: string;
  action: RepoActionKind;
  project: string;
  ok: boolean;
  detail?: string;
  error?: string;
  errorCode?: string;
  errorParams?: Record<string, string | number>;
  needsForce?: boolean;
}

export type RepoActionKind =
  'stage' | 'unstage' | 'commit' | 'push' | 'worktreeRemove' | 'worktreeNew' | 'merge';

export interface OfficeSnapshot {
  type: 'officeSnapshot';
  readOnly: boolean;
  chat?: boolean;
  tabs: OfficeRoom[];
  orchestrators: OfficeOrchestrator[];
}

export interface OfficeRoom {
  name: string;
  kind: OfficeRoomKind;
  order: number;
}

export type OfficeRoomKind = 'orch' | 'ops';

export interface OfficeOrchestrator {
  name: string;
  dir: string;
  title?: string | null;
  tab: string;
  order: number;
  state: SessionProcessState;
  busy: boolean | null;
  pid?: number | null;
  sessionId?: string | null;
  bg?: BackgroundSession | null;
  remoteControl: RemoteControlState;
  compactions: number;
  alive: boolean;
  agentId: number | null;
  provider?: OrchestratorProvider;
  level?: OfficeLevel;
  renewing?: boolean;
  heldEdits?: number;
}

export type SessionProcessState = 'running' | 'off';

export interface BackgroundSession {
  id: string;
  state: string;
  sessionId?: string | null;
  started?: string | null;
}

export interface RemoteControlState {
  on: boolean;
  url: string | null;
}

export type OrchestratorProvider = 'engine' | 'claude';

export interface OfficeLevel {
  level: number;
  xp: number;
  floor: number;
  next: number;
  rebirths: number;
}

export interface CodexTasks {
  type: 'codexTasks';
  tasks: CodexTask[];
}

export interface CodexTask {
  id: string;
  project: string;
  model?: string | null;
  state: CodexTaskState;
  pid?: number | null;
  branch?: string | null;
  created?: string | null;
  started?: string | null;
  ended?: string | null;
  exit?: number | null;
  resetAt?: string | null;
  progressDone?: number | null;
  progressTotal?: number | null;
  commits?: number | null;
  agentId?: number | null;
  spec?: string | null;
  title?: string | null;
  provider?: OrchestratorProvider;
  agent?: string;
  task?: string;
}

export type CodexTaskState = 'running' | 'limit' | 'done' | 'failed' | 'stopped' | 'unknown';

export interface TempStaff {
  type: 'tempStaff';
  staff: TempEmployee[];
}

export interface TempEmployee {
  execution: string;
  employeeId: string;
  nameId: string;
  project: string;
  working: boolean;
  level?: OfficeLevel;
  contextTokens?: number;
  maxContextTokens?: number;
}

export interface OfficeJobs {
  type: 'officeJobs';
  jobs: OfficeJob[];
}

export interface OfficeJob {
  id?: string | null;
  label?: string | null;
  pid: number;
  project: string | null;
  cmd: string;
  tab?: string | null;
  created?: string | null;
  started?: string | null;
  ended?: string | null;
  exit?: number | null;
  progress?: JobProgress | null;
  gpu?: GpuJobState | null;
  gpuId?: string | null;
  stopped?: boolean;
}

export interface JobProgress {
  label?: string | null;
  pct: number;
  rate?: string | null;
  eta?: string | null;
  indeterminate?: boolean;
}

export type GpuJobState = 'queued' | 'leased' | 'done';

export interface HwSample {
  type: 'hwSample';
  ts?: string | null;
  stale: boolean;
  cpuTempC?: number | null;
  cpuPowerW?: number | null;
  cpuUtil?: number | null;
  gpuTempC?: number | null;
  gpuHotspotC?: number | null;
  gpuPowerW?: number | null;
  gpuUtil?: number | null;
  vramUsedMib?: number | null;
  vramTotalMib?: number | null;
  cpuCores?: HwCpuCore[];
  cpuCoresW?: number | null;
  cpuCoreMaxC?: number | null;
  cpuCoreAvgC?: number | null;
  cpuBusMhz?: number | null;
  ramDetail?: HwRamDetail;
  hostRamDetail?: HwHostRamDetail;
  gpus?: HwGpu[];
  ramUsedGib?: number | null;
  ramTotalGib?: number | null;
  hostRamUsedGib?: number | null;
  hostRamTotalGib?: number | null;
  topProcesses?: HwTopProcess[];
  gpuProcesses?: GpuProcess[] | null;
  swapUsedGib?: number | null;
  lhm?: boolean | null;
  disks: HwDisk[];
  warnings: string[];
  sources?: Record<string, HwReadingSource>;
  sensorsHint?: boolean | null;
}

export interface HwCpuCore {
  name: string;
  clockMhz?: number | null;
  tempC?: number | null;
  util?: number | null;
}

export interface HwRamDetail {
  usedGib: number;
  cachedGib?: number | null;
  availableGib: number;
  swapUsedGib?: number | null;
  swapTotalGib?: number | null;
}

export interface HwHostRamDetail {
  usedGib: number;
  availableGib: number;
  util?: number | null;
  virtualUsedGib?: number | null;
  virtualTotalGib?: number | null;
}

export interface HwGpu {
  name: string;
  tempC?: number | null;
  hotspotC?: number | null;
  powerW?: number | null;
  util?: number | null;
  vramUsedMib?: number | null;
  vramTotalMib?: number | null;
}

export interface HwTopProcess {
  pid: number;
  cpuPct: number;
  rssMib: number;
  command: string;
}

export interface GpuProcess {
  pid: number;
  usedMib: number | null;
  cmd?: string;
}

export interface HwDisk {
  name: string;
  freeGib: number | null;
  warnGib?: number | null;
  totalGib?: number | null;
  warning?: boolean;
  view?: HwDiskView;
}

export type HwDiskView = 'wsl' | 'windows';

export type HwReadingSource = 'lhm' | 'sysfs' | 'nvidia-smi' | 'os';

export interface UsageState {
  type: 'usageState';
  ts?: string | null;
  claude?: UsageWindow | null;
  codex?: UsageWindow | null;
}

export interface UsageWindow {
  fiveHourPct?: number | null;
  sevenDayPct?: number | null;
  fiveHourReset?: string | null;
  fiveHourIsReset?: boolean | null;
  sevenDayReset?: string | null;
  sevenDayIsReset?: boolean | null;
  models?: AnonymousSchema_572[];
}

export interface AnonymousSchema_572 {
  family: string;
  pct: number;
  reset?: string | null;
}

export interface CodexUsageCheckResult {
  type: 'codexUsageCheckResult';
  ok: boolean;
  error?: string;
  errorCode?: string;
  errorParams?: Record<string, string | number>;
}

export interface AgentRules {
  type: 'agentRules';
  language: AnonymousSchema_584;
  defaults: string;
  useBuiltInRules: boolean;
  text: string;
  error?: string;
  errorCode?: string;
  errorParams?: Record<string, string | number>;
}

export type AnonymousSchema_584 = 'ko' | 'en';

export interface NewAgentPermission {
  type: 'newAgentPermission';
  mode: AnonymousSchema_591;
  error?: string;
}

export type AnonymousSchema_591 = '' | 'ask' | 'bypass';

export interface GpuBoard {
  type: 'gpuBoard';
  holders: GpuTicket[];
  queue: GpuTicket[];
  recent: GpuEnd[];
  unleased?: GpuProcess[];
  processesUnknown?: boolean;
}

export interface GpuTicket {
  id: string;
  project: string;
  label?: string | null;
  vramGib?: number | null;
  exclusive: boolean;
  ts: string;
  ticket: number;
}

export interface GpuEnd {
  id: string;
  project: string;
  label?: string | null;
  kind: GpuEndKind;
  reason?: string | null;
  errorCode?: string;
  errorParams?: Record<string, string | number>;
  exit?: number | null;
  ts: string;
}

export type GpuEndKind = 'release' | 'cancel';

export interface OfficeEvent {
  type: 'officeEvent';
  ts: string;
  kind: string;
  source?: string | null;
  name?: string | null;
  summary: string;
  ref?: string | null;
  provider?: AnonymousSchema_620;
  period?: AnonymousSchema_621;
}

export type AnonymousSchema_620 = 'claude' | 'codex' | 'null';

export type AnonymousSchema_621 = 'fiveHour' | 'sevenDay' | 'null';

export interface StatusOutput {
  type: 'statusOutput';
  name: string;
  cmd?: string | null;
  isDefault: boolean;
  exit?: number | null;
  output: string;
  truncated: boolean;
  git?: GitSummary | null;
}

export interface GitSummary {
  branch?: string | null;
  dirty?: number | null;
  recent: GitCommit[];
}

export interface GitCommit {
  hash: string;
  subject: string;
  time?: string | null;
}

export interface ChatTranscript {
  type: 'chatTranscript';
  agentId: number;
  items: ChatItem[];
  canSend: boolean;
  append?: boolean;
  queued?: ChatQueued[];
}

export interface ChatItem {
  kind: ChatItemKind;
  text: string;
  toolName?: string;
  desc?: string;
  id: string;
  at: number;
  session?: string;
  sessionStart?: number;
  from?: ChatSender;
  fromName?: string;
  execution?: string;
  employee?: ChatEmployee;
  attachments?: ChatAttachment[];
  messageId?: string;
  replyTo?: ChatReply;
}

export type ChatItemKind = 'user' | 'assistant' | 'tool' | 'result';

export type ChatSender = 'peer' | 'system';

export interface ChatEmployee {
  employeeId: string;
  nameId: string;
}

export interface ChatAttachment {
  name: string;
  path?: string;
  type?: string;
  sizeKb?: number;
  unavailable?: boolean;
}

export interface ChatReply {
  id: string;
  sender?: string;
  text: string;
}

export interface ChatQueued {
  id: string;
  text: string;
  at: number;
  now?: boolean;
  edited?: boolean;
  cancelled?: boolean;
  held?: boolean;
  messageId?: string;
  replyTo?: ChatReply;
}

export interface ChatHistoryResult {
  type: 'chatHistoryResult';
  requestId: string;
  agentId: number;
  items: ChatItem[];
  done: boolean;
  error?: string;
  errorCode?: string;
  errorParams?: Record<string, string | number>;
}

export interface ChatSearchResult {
  type: 'chatSearchResult';
  requestId: string;
  agentId: number;
  hits: ChatSearchHit[];
  truncated: boolean;
  error?: string;
  errorCode?: string;
  errorParams?: Record<string, string | number>;
}

export interface ChatSearchHit {
  id: string;
  at: number;
  kind: ChatSearchKind;
  snippet: string;
  session?: string;
  sessionStart?: number;
}

export type ChatSearchKind = 'user' | 'assistant';

export interface WorkContent {
  type: 'workContent';
  kind: WorkKind;
  agentId?: number;
  id?: string;
  title?: string;
  items: ChatItem[];
  append?: boolean;
  error?: string;
  errorCode?: string;
  errorParams?: Record<string, string | number>;
}

export type WorkKind = 'subagent' | 'teammate';

export interface ChatSendResult {
  type: 'chatSendResult';
  requestId: string;
  name: string;
  ok: boolean;
  delivered?: string;
  error?: string;
  errorCode?: string;
  errorParams?: Record<string, string | number>;
  queueId?: string;
  messageId?: string;
}

export interface ChatPendingResult {
  type: 'chatPendingResult';
  requestId: string;
  name: string;
  id: string;
  ok: boolean;
  error?: string;
  errorCode?: string;
  errorParams?: Record<string, string | number>;
  gone?: boolean;
}

export interface PermissionAnswerResult {
  type: 'permissionAnswerResult';
  requestId: string;
  agentId: number;
  ok: boolean;
  result?: PermissionAnswerOutcome;
  error?: string;
  errorCode?: string;
  errorParams?: Record<string, string | number>;
}

export type PermissionAnswerOutcome =
  'answered' | 'noDialog' | 'otherDialog' | 'notCleared' | 'gone' | 'failed';

export interface SlashCommandsList {
  type: 'slashCommandsList';
  requestId: string;
  agentId: number;
  commands: SlashCommand[];
  error?: string;
  errorCode?: string;
  errorParams?: Record<string, string | number>;
}

export interface SlashCommand {
  name: string;
  args?: string;
  description: string;
  source: SlashCommandSource;
  confirm?: boolean;
  argsRequired?: boolean;
}

export type SlashCommandSource = 'builtin' | 'user' | 'project';

export interface MessengerContacts {
  type: 'messengerContacts';
  contacts: MessengerContact[];
}

export interface MessengerContact {
  agentId: number;
  name: string;
  project?: string;
  preview?: string;
  lastAt?: number;
  lastKind?: ChatItemKind;
  lastFrom?: ChatSender;
  lastFromName?: string;
  canSend?: boolean;
  held?: boolean;
  permission?: PermissionWait;
  room?: string;
  roomId?: string;
  roomPost?: string;
  roomReply?: MessengerRoomReply;
  replies: string[];
}

export interface PermissionWait {
  toolId: string;
  tool?: string;
  detail?: string;
  asker?: string;
}

export interface MessengerRoomReply {
  id: string;
  text: string;
}

export interface GroupRooms {
  type: 'groupRooms';
  rooms: GroupRoom[];
}

export interface GroupRoom {
  id: string;
  name: string;
  members: string[];
  preview?: string;
  lastAt?: number;
  updates?: string[];
  systemLines?: boolean;
}

export interface GroupTimeline {
  type: 'groupTimeline';
  room: GroupRoom;
  posts: GroupPostItem[];
}

export interface GroupPostItem {
  id: string;
  at: number;
  sender?: string;
  text: string;
  targets: string[];
  delivery: Record<string, GroupDelivery>;
  replyTo?: ChatReply;
  system?: boolean;
  replies: GroupReply[];
}

export type GroupDelivery = 'pending' | 'delivered' | 'held' | 'off';

export interface GroupReply {
  member: string;
  messageId?: string;
  items: ChatItem[];
}

export interface GroupActionResult {
  type: 'groupActionResult';
  requestId: string;
  ok: boolean;
  error?: string;
  errorCode?: string;
  errorParams?: Record<string, string | number>;
}

export interface EzRules {
  type: 'ezRules';
  tools: EzToolRule[];
  commands: EzCommandRule[];
  fatigue?: EzFatigue;
}

export interface EzToolRule {
  tool: string[];
  emoji: string;
  text: string;
}

export interface EzCommandRule {
  program: string[];
  sub?: string[];
  subContains?: string[];
  has?: string[];
  contains?: string[];
  emoji: string;
  text: string;
}

export interface EzFatigue {
  compactionDrop?: number;
  tired?: number;
  yawn?: number;
  rest?: number;
}

export interface EngineState {
  type: 'engineState';
  projects: EngineProject[];
  warnings?: string[];
  agentChoices?: InstalledAgentChoices;
}

export interface EngineProject {
  compactionNudge?: number;
  name: string;
  role?: WorkerRole;
  project?: string;
  folder: string;
  room: string;
  rulesFile?: string;
  model?: string;
  permissionMode?: string;
  effort?: string;
  remoteControl?: boolean;
  alwaysOn?: boolean;
  title?: string;
  wantRunning: boolean;
  live: boolean;
  bgId?: string;
  sessionId?: string;
  needsTrust?: boolean;
  trusting?: boolean;
  downNote?: string;
  provider?: string;
}

export type WorkerRole = 'worker' | 'reviewer';

export interface InstalledAgentChoices {
  claude?: AgentChoices;
  codex?: AgentChoices;
}

export interface AgentChoices {
  version?: string;
  models: string[];
  efforts: string[];
  permissionModes?: string[];
  defaultModel?: string;
  defaultEffort?: string;
}

export interface EngineActionResult {
  type: 'engineActionResult';
  requestId: string;
  action: EngineActionKind;
  name: string;
  ok: boolean;
  bgId?: string;
  note?: string;
  error?: string;
  errorCode?: string;
  errorParams?: Record<string, string | number>;
  folderMissing?: boolean;
}

export type EngineActionKind = 'add' | 'edit' | 'remove' | 'start' | 'stop' | 'restart' | 'promote';

export interface ProjectScanResult {
  type: 'projectScanResult';
  requestId: string;
  ok: boolean;
  error?: string;
  errorCode?: string;
  errorParams?: Record<string, string | number>;
  candidates: ProjectImportCandidate[];
}

export interface ProjectImportCandidate {
  folder: string;
  name: string;
  room: string;
  sessionId?: string;
  lastActivity?: string;
  title?: string;
  live: boolean;
  branch?: string;
  already: boolean;
}

export interface ProjectImportResult {
  type: 'projectImportResult';
  requestId: string;
  batchId?: string;
  rows: ProjectImportItemResult[];
}

export interface ProjectImportItemResult {
  folder: string;
  name: string;
  status: AnonymousSchema_870;
  reason?: string;
  errorCode?: string;
  errorParams?: Record<string, string | number>;
}

export type AnonymousSchema_870 = 'added' | 'skipped' | 'failed' | 'removed';

export interface ProjectImportSuggestion {
  type: 'projectImportSuggestion';
  folder: string;
}

export interface JobActionResult {
  type: 'jobActionResult';
  requestId: string;
  action: JobActionKind;
  id: string;
  ok: boolean;
  log?: string;
  logPath?: string;
  truncated?: boolean;
  digest?: JobDigest;
  error?: string;
  errorCode?: string;
  errorParams?: Record<string, string | number>;
}

export type JobActionKind = 'log' | 'stop';

export interface JobDigest {
  steps: JobDigestStep[];
  lines: JobDigestLine[];
}

export interface JobDigestStep {
  name: string;
  state: AnonymousSchema_884;
}

export type AnonymousSchema_884 = 'done' | 'running' | 'failed' | 'waiting';

export interface JobDigestLine {
  text: string;
  error: boolean;
}

export interface ViewerVisibilityAck {
  type: 'viewerVisibilityAck';
  visible: boolean;
}

export interface BuildingState {
  type: 'buildingState';
  floors: BuildingFloor[];
  perProject: boolean;
  decor?: BuildingDecor[];
  error?: string;
  errorCode?: string;
  errorParams?: Record<string, string | number>;
}

export interface BuildingFloor {
  id: string;
  name: string;
  rooms: string[];
  characters: string[];
}

export interface BuildingDecor {
  room: string;
  stored: number;
}

export interface HostInfo {
  type: 'hostInfo';
  os: HostOs;
  home: string;
  pathStyle: PathStyle;
  sep: string;
  caseInsensitive: boolean;
  distro?: string;
  mnt?: string;
  utcOffsetMin?: number;
}

export type HostOs = 'linux' | 'wsl' | 'darwin' | 'win32';

export type PathStyle = 'posix' | 'win32';

export interface FolderList {
  type: 'folderList';
  requestId: string;
  ok: boolean;
  error?: string;
  errorCode?: string;
  errorParams?: Record<string, string | number>;
  path?: string;
  display?: string;
  parent?: string | null;
  roots: FolderRoot[];
  entries: FolderEntry[];
  truncated?: boolean;
  warnings?: string[];
}

export interface FolderRoot {
  label: string;
  path: string;
}

export interface FolderEntry {
  name: string;
  path: string;
}

export interface PushState {
  type: 'pushState';
  available: boolean;
  publicKey: string | null;
  subscribed: boolean;
  error?: string | null;
  errorCode?: string;
  errorParams?: Record<string, string | number>;
}

export interface WhiteboardMemos {
  type: 'whiteboardMemos';
  memos: WhiteboardMemo[];
}

export interface WhiteboardMemo {
  uid: string;
  text: string;
  updatedAt: number;
}

export interface PinnedConversations {
  type: 'pinnedConversations';
  keys: string[];
}

export interface TaskBoard {
  type: 'taskBoard';
  tasks: BoardTask[];
  corrupt?: string;
  error?: string;
  errorCode?: string;
  errorParams?: Record<string, string | number>;
  removedAssignees?: string[];
}

export interface BoardTask {
  id: string;
  project: string;
  title: string;
  detail?: string;
  status: BoardTaskStatus;
  priority?: BoardTaskPriority;
  goal?: string;
  owner?: BoardTaskOwner;
  branch?: string;
  worktree?: string;
  links?: BoardTaskLink[];
  note?: string;
  source: BoardTaskSource;
  externalRef?: BoardTaskExternalRef;
  createdAt: string;
  updatedAt: string;
  history: BoardTaskChange[];
  parentId?: string;
  assignee?: BoardTaskAssignee;
  createdBy?: string;
  delegatedBy?: string;
  statusSource?: BoardFactSource;
  reportedDone?: BoardFactBool;
  commits?: BoardFactNumber;
  filesChanged?: BoardFactNumber;
  testsRan?: BoardFactBool;
  testsPassed?: BoardFactBool;
  executions?: BoardExecution[];
  budget?: BoardTaskBudget;
}

export type BoardTaskStatus = 'proposed' | 'todo' | 'doing' | 'review' | 'blocked' | 'done';

export type BoardTaskPriority = 'P0' | 'P1' | 'P2' | 'later';

export interface BoardTaskOwner {
  kind: BoardTaskOwnerKind;
  name: string;
}

export type BoardTaskOwnerKind = 'lead' | 'worker' | 'subagent' | 'codex' | 'user' | 'unassigned';

export interface BoardTaskLink {
  kind: BoardTaskLinkKind;
  ref: string;
}

export type BoardTaskLinkKind = 'codex' | 'job' | 'url';

export type BoardTaskSource = 'reported' | 'observed';

export interface BoardTaskExternalRef {
  system: string;
  key: string;
  url?: string;
}

export interface BoardTaskChange {
  at: string;
  by: string;
  change: string;
}

export interface BoardTaskAssignee {
  assignmentId: string;
  name: string;
}

export type BoardFactSource = 'observed' | 'reported' | 'inferred' | 'unknown';

export interface BoardFactBool {
  value: boolean;
  source: BoardFactSource;
  at: string;
}

export interface BoardFactNumber {
  value: number;
  source: BoardFactSource;
  at: string;
}

export interface BoardExecution {
  id: string;
  kind: BoardExecutionKind;
  ref: string;
  startedAt?: string;
  endedAt?: BoardFactTime;
  exit?: BoardFactNumber;
  commits?: BoardFactNumber;
  log?: string;
  limit?: BoardFactLimit;
  summary?: BoardFactText;
}

export type BoardExecutionKind = 'codex' | 'job' | 'agent';

export interface BoardFactTime {
  value: string;
  source: BoardFactSource;
  at: string;
}

export interface BoardFactLimit {
  value: BoardLimitValue;
  source: BoardFactSource;
  at: string;
}

export interface BoardLimitValue {
  resetAt?: string;
}

export interface BoardFactText {
  value: string;
  source: BoardFactSource;
  at: string;
}

export interface BoardTaskBudget {
  maxTurns?: number;
  maxMinutes?: number;
}

export interface DelegationApprovals {
  type: 'delegationApprovals';
  approvals: DelegationApproval[];
  requestId?: string;
  error?: string;
  errorCode?: string;
  errorParams?: Record<string, string | number>;
  outcome?: string;
  taskId?: string;
}

export interface DelegationApproval {
  id: string;
  project: string;
  caller: string;
  check: DelegationCheck;
  why: string;
  title: string;
  target: string;
  newWorker: boolean;
  createdAt: string;
  counts?: DelegationCounts;
}

export type DelegationCheck = 'mode' | 'limits';

export interface DelegationCounts {
  workersRunning: number[];
  hostWorkersRunning: number[];
  newWorkersToday: number[];
  delegationsToday: number[];
}

export interface TrackedItems {
  type: 'trackedItems';
  project: string;
  items: TrackedItem[];
  more?: TrackedMore[];
}

export interface TrackedItem {
  key: string;
  kind: TrackedKind;
  parentKey?: string;
  title: string;
  status: TrackedStatus;
  rawStatus?: string;
  source: BoardFactSource;
  reporter?: string;
  ref?: string;
  changedAt?: string | null;
  taskId?: string;
  ended?: boolean;
  unreadable?: boolean;
  path?: string;
  line?: number;
  refs?: string[];
  duplicate?: boolean;
  gone?: boolean;
}

export type TrackedKind = 'session' | 'agentList' | 'codexProgress' | 'doc';

export type TrackedStatus =
  'todo' | 'doing' | 'review' | 'blocked' | 'done' | 'cancelled' | 'unknown';

export interface TrackedMore {
  parentKey: string;
  count: number;
}

export interface TrackingSources {
  type: 'trackingSources';
  project: string;
  settings: TrackingProjectSettings;
  found: TrackingDoc[];
  candidates: string[];
  error?: string;
  errorCode?: string;
  errorParams?: Record<string, string | number>;
}

export interface TrackingProjectSettings {
  on: string[];
  off: string[];
  shortIds: boolean;
  hidden: string[];
}

export interface TrackingDoc {
  path: string;
  conventional: boolean;
  on: boolean;
  items?: number;
}

export interface WebviewReady {
  type: 'webviewReady';
}

export interface LaunchAgent {
  type: 'launchAgent';
  directoryPath?: string;
}

export interface FocusAgent {
  type: 'focusAgent';
  id: number;
}

export interface CloseAgent {
  type: 'closeAgent';
  id: number;
}

export interface SaveAgentSeats {
  type: 'saveAgentSeats';
  seats: Record<string, SeatAssignment>;
}

export interface SeatAssignment {
  palette: number;
  hueShift: number;
  seatId: string | null;
}

export interface SaveLayout {
  type: 'saveLayout';
  layout: Record<string, any>;
}

export interface SetSoundEnabled {
  type: 'setSoundEnabled';
  enabled: boolean;
}

export interface SetLastSeenVersion {
  type: 'setLastSeenVersion';
  version: string;
}

export interface SetAlwaysShowLabels {
  type: 'setAlwaysShowLabels';
  enabled: boolean;
}

export interface SetGhostHeadlessAgents {
  type: 'setGhostHeadlessAgents';
  enabled: boolean;
}

export interface SetHooksEnabled {
  type: 'setHooksEnabled';
  providerId: string;
  enabled: boolean;
}

export interface HooksConsentResponse {
  type: 'hooksConsentResponse';
  providerId: string;
  choice: HooksConsentChoice;
}

export type HooksConsentChoice = 'install' | 'notNow' | 'never';

export interface SetHooksInfoShown {
  type: 'setHooksInfoShown';
}

export interface SetWatchAllSessions {
  type: 'setWatchAllSessions';
  enabled: boolean;
}

export interface ExportLayout {
  type: 'exportLayout';
}

export interface ImportLayout {
  type: 'importLayout';
}

export interface OpenSessionsFolder {
  type: 'openSessionsFolder';
}

export interface AddExternalAssetDirectory {
  type: 'addExternalAssetDirectory';
  path?: string;
}

export interface RemoveExternalAssetDirectory {
  type: 'removeExternalAssetDirectory';
  path: string;
}

export interface SaveAreaMappings {
  type: 'saveAreaMappings';
  mappings: Record<string, string[]>;
}

export interface SetShowAreas {
  type: 'setShowAreas';
  enabled: boolean;
}

export interface SetBypassPermissions {
  type: 'setBypassPermissions';
  enabled: boolean;
}

export interface SetShowHostDirectories {
  type: 'setShowHostDirectories';
  enabled: boolean;
}

export interface SaveDirectory {
  type: 'saveDirectory';
  name: string;
  path: string;
  previousPath?: string;
}

export interface RemoveDirectory {
  type: 'removeDirectory';
  path: string;
}

export interface RequestDirectorySuggestions {
  type: 'requestDirectorySuggestions';
}

export interface RequestDiagnostics {
  type: 'requestDiagnostics';
}

export interface SetCharacter {
  type: 'setCharacter';
  key: string;
  character: CharacterChoice | null;
}

export interface RepoView {
  type: 'repoView';
  project: string;
  on: boolean;
}

export interface RepoDiffRequest {
  type: 'repoDiffRequest';
  requestId: string;
  project: string;
  task?: string;
  path: string;
  staged: boolean;
  offset?: number;
}

export interface RepoWorktreeRequest {
  type: 'repoWorktreeRequest';
  requestId: string;
  project: string;
  task: string;
}

export interface RepoAction {
  type: 'repoAction';
  requestId: string;
  action: RepoActionKind;
  project: string;
  paths?: string[];
  message?: string;
  task?: string;
  force?: boolean;
  taskId?: string;
  assignee?: string;
  base?: string;
}

export interface StatusView {
  type: 'statusView';
  name: string;
  on: boolean;
}

export interface ChatView {
  type: 'chatView';
  agentId: number;
  on: boolean;
}

export interface ChatHistory {
  type: 'chatHistory';
  agentId: number;
  requestId: string;
  before?: string;
  until?: number;
}

export interface ChatSearch {
  type: 'chatSearch';
  agentId: number;
  requestId: string;
  query: string;
}

export interface WorkView {
  type: 'workView';
  kind: WorkKind;
  agentId?: number;
  id?: string;
  on: boolean;
}

export interface ChatSend {
  type: 'chatSend';
  requestId: string;
  name: string;
  text: string;
  now?: boolean;
  replyTo?: ChatReply;
}

export interface ChatSendNow {
  type: 'chatSendNow';
  requestId: string;
  name: string;
  id: string;
}

export interface ChatCancel {
  type: 'chatCancel';
  requestId: string;
  name: string;
  id: string;
}

export interface ChatEdit {
  type: 'chatEdit';
  requestId: string;
  name: string;
  id: string;
  text: string;
}

export interface ChatHold {
  type: 'chatHold';
  name: string;
  id: string;
  on: boolean;
}

export interface PermissionAnswer {
  type: 'permissionAnswer';
  requestId: string;
  agentId: number;
  toolId: string;
  allow: boolean;
}

export interface GroupView {
  type: 'groupView';
  room: string;
  on: boolean;
}

export interface GroupPost {
  type: 'groupPost';
  requestId: string;
  room: string;
  text: string;
  replyTo?: ChatReply;
}

export interface GroupAction {
  type: 'groupAction';
  requestId: string;
  action: AnonymousSchema_1195;
  id?: string;
  name?: string;
  members?: string[];
  on?: boolean;
}

export type AnonymousSchema_1195 = 'create' | 'rename' | 'delete' | 'setMembers' | 'systemLines';

export interface SlashCommands {
  type: 'slashCommands';
  requestId: string;
  agentId: number;
}

export interface EngineAction {
  type: 'engineAction';
  requestId: string;
  action: EngineActionKind;
  name: string;
  role?: WorkerRole;
  project?: string;
  folder?: string;
  room?: string;
  rulesFile?: string;
  model?: string;
  permissionMode?: string;
  effort?: string;
  remoteControl?: boolean;
  alwaysOn?: boolean;
  title?: string;
  mkdir?: boolean;
  compactionNudge?: number;
  oldLead?: EngineOldLead;
  provider?: string;
}

export type EngineOldLead = 'worker' | 'stop';

export interface EngineChoicesRefresh {
  type: 'engineChoicesRefresh';
}

export interface ProjectScan {
  type: 'projectScan';
  requestId: string;
  folder?: string;
}

export interface ProjectImport {
  type: 'projectImport';
  requestId: string;
  folder: string;
  rows: ProjectImportRow[];
}

export interface ProjectImportRow {
  folder: string;
  name: string;
  room: string;
  resume: boolean;
  start: boolean;
}

export interface ProjectImportUndo {
  type: 'projectImportUndo';
  requestId: string;
  batchId: string;
}

export interface ProjectImportDismiss {
  type: 'projectImportDismiss';
}

export interface JobAction {
  type: 'jobAction';
  requestId: string;
  action: JobActionKind;
  id: string;
}

export interface ViewerVisibility {
  type: 'viewerVisibility';
  visible: boolean;
}

export interface HwView {
  type: 'hwView';
  on: boolean;
}

export interface AddFloor {
  type: 'addFloor';
  name?: string;
}

export interface RenameFloor {
  type: 'renameFloor';
  floorId: string;
  name: string;
}

export interface RemoveFloor {
  type: 'removeFloor';
  floorId: string;
}

export interface MoveToFloor {
  type: 'moveToFloor';
  floorId: string;
  room?: string;
  character?: string;
}

export interface SetFloorRule {
  type: 'setFloorRule';
  perProject: boolean;
}

export interface ResetRoomDecor {
  type: 'resetRoomDecor';
  room: string;
}

export interface ListFolders {
  type: 'listFolders';
  requestId: string;
  path?: string;
  hidden?: boolean;
}

export interface PushSubscribe {
  type: 'pushSubscribe';
  endpoint: string;
  p256dh: string;
  auth: string;
  kinds: NoticeKind[];
  kindsOff?: NoticeKind[];
  subagents: boolean;
  remoteTurnEnds?: boolean;
  lang?: AnonymousSchema_1271;
}

export type NoticeKind = 'turnEnd' | 'attention' | 'job' | 'reply';

export type AnonymousSchema_1271 = 'en' | 'ko';

export interface PushUnsubscribe {
  type: 'pushUnsubscribe';
}

export interface SetWhiteboardMemo {
  type: 'setWhiteboardMemo';
  uid: string;
  text: string;
}

export interface SetConversationPin {
  type: 'setConversationPin';
  key: string;
  pinned: boolean;
}

export interface TaskEdit {
  type: 'taskEdit';
  id?: string;
  fields: TaskEditFields;
}

export interface TaskEditFields {
  project?: string;
  title?: string;
  status?: BoardTaskStatus;
  priority?: string;
  owner?: BoardTaskOwner;
  note?: string;
}

export interface CodexUsageCheck {
  type: 'codexUsageCheck';
}

export interface AgentRulesRequest {
  type: 'agentRulesRequest';
  language: AnonymousSchema_1287;
  text?: string;
  useBuiltInRules?: boolean;
}

export type AnonymousSchema_1287 = 'ko' | 'en';

export interface NewAgentPermissionRequest {
  type: 'newAgentPermissionRequest';
  mode: AnonymousSchema_1291;
}

export type AnonymousSchema_1291 = 'ask' | 'bypass';

export interface DelegationDecision {
  type: 'delegationDecision';
  requestId: string;
  id: string;
  decision: DelegationDecisionKind;
  reason?: string;
  errorCode?: string;
  errorParams?: Record<string, string | number>;
}

export type DelegationDecisionKind = 'approve' | 'deny';

export interface TrackingSettings {
  type: 'trackingSettings';
  project: string;
  settings?: TrackingProjectSettings;
  hide?: string;
}
