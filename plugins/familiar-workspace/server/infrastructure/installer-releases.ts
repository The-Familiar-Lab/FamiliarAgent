export const INFRASTRUCTURE_RELEASES = {
  skulk: {
    version: "0.7.1",
    platforms: {
      "darwin-arm64": [
        {
          binary: "skulk",
          url: "https://github.com/frantufro/skulk/releases/download/v0.7.1/skulk-aarch64-apple-darwin.tar.gz",
          sha256: "a87e31f3904db53a3d2068f46848c8bc48b3cd3540eacb7ce37d127b07e5996f",
        },
      ],
      "linux-x64": [
        {
          binary: "skulk",
          url: "https://github.com/frantufro/skulk/releases/download/v0.7.1/skulk-x86_64-unknown-linux-gnu.tar.gz",
          sha256: "675003ffd569879f174976c8a4abd5c651a168d033ea19edd213e91d54af253a",
        },
      ],
      "linux-arm64": [
        {
          binary: "skulk",
          url: "https://github.com/frantufro/skulk/releases/download/v0.7.1/skulk-aarch64-unknown-linux-gnu.tar.gz",
          sha256: "60c2cee28b7cc8b0c89fe90bacb09abbe5632571a449a5caae81b7e90d3c0718",
        },
      ],
    },
  },
  bssh: {
    version: "3.0.1",
    platforms: {
      "darwin-arm64": [
        {
          binary: "bssh",
          url: "https://github.com/lablup/bssh/releases/download/v3.0.1/bssh-macos-aarch64.zip",
          sha256: "a2ee176fec6291f5f198a30e7cce71d0a3b6129b5bed8ee4fa5497e3639a31f6",
        },
      ],
      "linux-x64": [
        {
          binary: "bssh",
          url: "https://github.com/lablup/bssh/releases/download/v3.0.1/bssh-linux-x86_64-musl.tar.gz",
          sha256: "a1843de59eb8073c184798a2190a39932a0d0b9495d527bab1fa0818115cdfbd",
        },
      ],
      "linux-arm64": [
        {
          binary: "bssh",
          url: "https://github.com/lablup/bssh/releases/download/v3.0.1/bssh-linux-aarch64-musl.tar.gz",
          sha256: "8fe93554347bd2b3ed3fcdd959da2fbef8210423179ca376adfb840e62a28850",
        },
      ],
    },
  },
  coder: {
    version: "2.36.7",
    platforms: {
      "darwin-arm64": [
        {
          binary: "coder",
          url: "https://github.com/coder/coder/releases/download/v2.36.7/coder_2.36.7_darwin_arm64.zip",
          sha256: "ee83f30ffb7e3c771eacb44f2e4825b864c7df1f88d0e4e1b6e4dac775ba9a8f",
        },
      ],
      "darwin-x64": [
        {
          binary: "coder",
          url: "https://github.com/coder/coder/releases/download/v2.36.7/coder_2.36.7_darwin_amd64.zip",
          sha256: "8b1206f0c8d5ba2e6d3ab6a1ccb5aebba42a7acc625b82bbdd06c46366380752",
        },
      ],
      "linux-x64": [
        {
          binary: "coder",
          url: "https://github.com/coder/coder/releases/download/v2.36.7/coder_2.36.7_linux_amd64.tar.gz",
          sha256: "0bdf09731e36174a27db6e09df5345fd1aad13a3a35df9593ba211594f2ff1d1",
        },
      ],
      "linux-arm64": [
        {
          binary: "coder",
          url: "https://github.com/coder/coder/releases/download/v2.36.7/coder_2.36.7_linux_arm64.tar.gz",
          sha256: "eee4f2579bdea19f17e2db1c3893ecad1a0f428f974ec68cb8f75e8e70fc8c0b",
        },
      ],
    },
  },
  juicefs: {
    version: "1.4.1",
    platforms: {
      "darwin-arm64": [
        {
          binary: "juicefs",
          url: "https://github.com/juicedata/juicefs/releases/download/v1.4.1/juicefs-1.4.1-darwin-arm64.tar.gz",
          sha256: "e77739762a94e6ad90d27a97027de214d63516828e90fac86221c88850b82b08",
        },
      ],
      "darwin-x64": [
        {
          binary: "juicefs",
          url: "https://github.com/juicedata/juicefs/releases/download/v1.4.1/juicefs-1.4.1-darwin-amd64.tar.gz",
          sha256: "69a25ad81128521c14376a341000c52435f5171a3b23ff1c44aa5e0b6ccc1c7e",
        },
      ],
      "linux-x64": [
        {
          binary: "juicefs",
          url: "https://github.com/juicedata/juicefs/releases/download/v1.4.1/juicefs-1.4.1-linux-amd64.tar.gz",
          sha256: "01ee09a21a9351a465e09906f113845e1c6a19bea70f530e5e2b2125b2dd3b82",
        },
      ],
      "linux-arm64": [
        {
          binary: "juicefs",
          url: "https://github.com/juicedata/juicefs/releases/download/v1.4.1/juicefs-1.4.1-linux-arm64.tar.gz",
          sha256: "1015ade83a7a93180a29f6c93ee5780a3eda52522331934ef2ef0cc0921995fd",
        },
      ],
    },
  },
  firetower: {
    version: "0.44.0",
    platforms: {
      "linux-x64": [
        {
          binary: "firetower",
          url: "https://ghcr.io/v2/firetower-cloud/firetower/blobs/sha256:e2c1b297627fce650d219cbc346e7e00539ed2e93e30726cd3a1d62fb5037d54",
          sha256: "e2c1b297627fce650d219cbc346e7e00539ed2e93e30726cd3a1d62fb5037d54",
          tokenUrl: "https://ghcr.io/token?scope=repository:firetower-cloud/firetower:pull",
          member: "usr/local/bin/firetower",
        },
        {
          binary: "firetower-worker",
          url: "https://github.com/firetower-cloud/firetower/releases/download/firetower-v0.44.0/firetower-worker-linux-x86_64.tar.gz",
          sha256: "7abd4d93fe16eb81c962112d056a6897c11e2213b73d2635229f81ecbc40e2cd",
        },
      ],
    },
  },
} as const;
