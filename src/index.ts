export {
  buildWindowsPowerShellInvocation,
  createWindowsDesktopObservationAdapter,
  defaultWindowsPowerShellPath,
} from "./windowsObservationAdapter.js";

export type {
  WindowsDesktopObservationAdapter,
  WindowsObservationAdapterOptions,
  WindowsObservationWorker,
  WindowsObservationWorkerResponse,
  WindowsWorkerArtifactFile,
} from "./windowsObservationAdapter.js";

export {
  WINDOWS_PROVIDER_MAX_FRAME_BYTES,
  WINDOWS_PROVIDER_PROTOCOL_VERSION,
  decodeProviderRequestFrame,
  decodeProviderResponseFrame,
  encodeProviderFrame,
  providerErrorFingerprint,
  providerTransportFailureDisposition,
  validateProviderRequestEnvelope,
  validateProviderResponseEnvelope,
} from "./providerProtocol.js";

export type {
  ProviderJsonValue,
  ProviderTransportFailureDisposition,
  WindowsProviderError,
  WindowsProviderRequestEnvelope,
  WindowsProviderRequestKind,
  WindowsProviderResponseEnvelope,
  WindowsProviderResponseStatus,
} from "./providerProtocol.js";

export {
  ProviderEvidenceStore,
  assertPreDispatchWindowIdentity,
} from "./providerEvidenceStore.js";

export type {
  ProviderElementEvidence,
  ProviderElementEvidenceInput,
  ProviderEvidenceStoreOptions,
  ProviderWindowEvidence,
  ProviderWindowEvidenceInput,
} from "./providerEvidenceStore.js";

export {
  ProviderArtifactStore,
} from "./providerArtifacts.js";

export type {
  ProviderArtifactRecord,
  ProviderArtifactStoreOptions,
} from "./providerArtifacts.js";
