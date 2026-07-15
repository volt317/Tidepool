// GENERATED FILE — DO NOT EDIT.
//
// Source of truth: deploy/deploy.yaml (the single location for build/deploy
// configurables). Regenerate with `npm run generate:deploy-config`;
// `npm run build:server` does so automatically, and CI fails on drift.
//
// These values are baked at COMPILATION: the compiled JavaScript carries
// them as static consts and never reads deploy.yaml at runtime.

export const DEPLOY_CONFIG = {
  /** deploy.yaml: base_image */
  baseImage: "docker.io/library/node:22-bookworm-slim",
  /** deploy.yaml: container_gid */
  containerGid: 10001,
  /** deploy.yaml: container_uid */
  containerUid: 10001,
  /** deploy.yaml: data_root */
  dataRoot: "~/.local/share/tidepool",
  /** deploy.yaml: image_prefix */
  imagePrefix: "localhost/tidepool",
  /** deploy.yaml: internal_port */
  internalPort: 8747,
  /** deploy.yaml: listen_addr */
  listenAddr: "127.0.0.1",
  /** deploy.yaml: listen_port */
  listenPort: 8747,
} as const;
