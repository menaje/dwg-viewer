# `@dwg-viewer/render-protocol`

Viewer Core가 raw Scene Cache source와 Service-backed source를 같은 경계에서
열기 위한 source-neutral 계약입니다.

현재 `0.1.0`은 workspace-only experimental contract이며 다음을 검증합니다.

- exact semantic-version negotiation
- opaque session/source/revision identity
- current revision과 last-successful revision 분리
- generic 2D/3D layer manifest
- session/revision/layer에 묶인 bounded range handle
- stale revision, scope mismatch와 unknown field의 fail-closed 처리

이 package는 Spatial Workspace, Agent method, credential, 실제 file path와
기존 `dwg-*` Host–Webview message를 포함하지 않습니다.

```js
import {
  RenderCapability,
  RenderProtocolVersion,
  parseRenderSessionDescriptor,
} from "@dwg-viewer/render-protocol";

const descriptor = parseRenderSessionDescriptor({
  protocolVersion: RenderProtocolVersion,
  sessionId: "session:local-drawing",
  sourceId: "source:drawing",
  currentRevisionId: "revision:sha256:...",
  lastSuccessfulRevisionId: "revision:sha256:...",
  capabilities: [
    RenderCapability.LAYER_MANIFEST,
    RenderCapability.RENDER_SNAPSHOT,
  ],
  resourceBudgetBytes: 512 * 1024 * 1024,
});
```

Render Delta, pick identity와 typed ViewerHost event의 세부 payload는 #30과
#27의 후속 conformance에서 같은 protocol의 compatible version으로
추가합니다.
