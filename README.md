# ERC-4337 abstraction-account-environment

ERC-4337 (Account Abstraction) 로컬 테스트 환경입니다.
번들러, 페이마스터를 직접 구축하여 전체 플로우를 검증합니다.

## 구성 요소

| 구성 요소 | 설명 |
|---|---|
| **EntryPoint** | ERC-4337 핵심 컨트랙트. UserOperation을 검증하고 실행 |
| **SimpleAccount** | 사용자의 스마트 컨트랙트 지갑 (EOA owner가 서명) |
| **SimpleAccountFactory** | CREATE2로 스마트 계정을 배포하는 팩토리 |
| **VerifyingPaymaster** | 서명 기반 가스비 대납 페이마스터 |
| **Bundler** | UserOperation을 수집하여 EntryPoint에 제출하는 JSON-RPC 서버 |

## 프로젝트 구조

```
erc4337-test/
├── contracts/
│   └── Imports.sol              # @account-abstraction 컨트랙트 import
├── lib/
│   ├── types.ts                 # PackedUserOperation 타입 정의
│   ├── userop.ts                # UserOp 구성, 가스 패킹, 해싱 헬퍼
│   └── paymaster.ts             # 페이마스터 서명 헬퍼
├── scripts/
│   ├── deploy.ts                # 컨트랙트 배포 + 페이마스터 자금/스테이킹
│   ├── run-full-flow.ts         # E2E 시연 스크립트 (EntryPoint 직접 호출)
│   └── send-via-bundler.ts      # 번들러 경유 인프라 테스트 스크립트
├── bundler/
│   ├── index.ts                 # Express JSON-RPC 서버 (port 4337)
│   ├── mempool.ts               # 인메모리 UserOp 메모리풀
│   └── builder.ts               # 번들 빌더 (handleOps 호출)
├── test/
│   └── e2e.test.ts              # Hardhat E2E 테스트
└── deployments/
    └── addresses.json           # 배포된 컨트랙트 주소 (deploy 후 생성)
```

## 설치

```bash
npm install
npx hardhat compile
```

## 사용법

### 1. 단위 테스트 (가장 간단)

별도 노드 없이 Hardhat 내장 네트워크에서 전체 플로우를 테스트합니다.

```bash
npm test
```

### 2. 로컬 노드에서 전체 플로우 시연

EntryPoint에 직접 `handleOps`를 호출하는 방식입니다.

```bash
# 터미널 1: 로컬 노드 실행
npm run node

# 터미널 2: 컨트랙트 배포 → 전체 플로우 실행
npm run deploy
npm run full-flow
```

### 3. 번들러 인프라 테스트

실제 인프라 구성(노드 + 번들러 + 클라이언트)을 분리하여 테스트합니다.
클라이언트가 번들러 JSON-RPC로 UserOp을 제출하고, 번들러가 EntryPoint에 중계합니다.

```bash
# 터미널 1: 로컬 노드
npm run node

# 터미널 2: 컨트랙트 배포
npm run deploy

# 터미널 3: 번들러 서버 시작
npm run bundler

# 터미널 2: 번들러 경유 인프라 테스트
npm run infra-test
```

### npm scripts 요약

| 스크립트 | 명령어 | 설명 |
|---|---|---|
| `npm test` | `hardhat test` | Hardhat 내장 네트워크에서 E2E 테스트 |
| `npm run node` | `hardhat node` | 로컬 노드 실행 (port 8545) |
| `npm run compile` | `hardhat compile` | Solidity 컨트랙트 컴파일 |
| `npm run deploy` | `hardhat run scripts/deploy.ts` | 컨트랙트 배포 + 페이마스터 자금/스테이킹 |
| `npm run bundler` | `ts-node bundler/index.ts` | 번들러 JSON-RPC 서버 시작 (port 4337) |
| `npm run full-flow` | `hardhat run scripts/run-full-flow.ts` | EntryPoint 직접 호출 E2E 시연 |
| `npm run infra-test` | `hardhat run scripts/send-via-bundler.ts` | 번들러 경유 인프라 테스트 |

## 번들러 JSON-RPC

번들러는 `http://localhost:4337`에서 JSON-RPC를 제공합니다.

**지원 메서드:**

| 메서드 | 설명 |
|---|---|
| `eth_sendUserOperation(userOp, entryPoint)` | UserOp 제출 → 번들러가 handleOps 호출 |
| `eth_supportedEntryPoints()` | 지원하는 EntryPoint 주소 반환 |
| `eth_chainId()` | 체인 ID 반환 |

**요청 예시:**

```bash
curl -X POST http://localhost:4337 \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "eth_supportedEntryPoints",
    "params": []
  }'
```

## 실행 플로우

### 페이마스터 없는 경우 (사용자가 직접 가스비 지불)

스마트 계정에 ETH가 있어야 하며, EntryPoint가 가스비를 해당 계정의 deposit에서 차감합니다.

```
Owner (EOA)
    │
    ▼
┌──────────────────────────────────────────────┐
│ 1. UserOperation 구성                         │
│    - sender: 스마트 계정 주소 (counterfactual) │
│    - initCode: 최초 배포 시 팩토리 호출        │
│    - callData: account.execute() 인코딩       │
│    - paymasterAndData: "0x" (비어있음)        │
└──────────────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────────┐
│ 2. 서명 (1개)                                 │
│    opHash = entryPoint.getUserOpHash(userOp)  │
│    signature = owner.sign(opHash)             │
└──────────────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────────┐
│ 3. EntryPoint.handleOps()                     │
│                                               │
│  ┌─ 검증 ─────────────────────────────────┐   │
│  │ account.validateUserOp()               │   │
│  │  └─ owner 서명 검증                     │   │
│  └────────────────────────────────────────┘   │
│              │                                │
│              ▼                                │
│  ┌─ 배포 (initCode 있을 때만) ────────────┐   │
│  │ factory.createAccount(owner, salt)     │   │
│  │  └─ CREATE2로 스마트 계정 배포          │   │
│  └────────────────────────────────────────┘   │
│              │                                │
│              ▼                                │
│  ┌─ 실행 ─────────────────────────────────┐   │
│  │ account.execute(dest, value, data)     │   │
│  │  └─ 실제 트랜잭션 수행                  │   │
│  └────────────────────────────────────────┘   │
│              │                                │
│              ▼                                │
│  ┌─ 가스 정산 ────────────────────────────┐   │
│  │ 스마트 계정의 deposit에서 가스비 차감 ✅ │   │
│  └────────────────────────────────────────┘   │
└──────────────────────────────────────────────┘
```

### 페이마스터 있는 경우 (가스비 대납)

사용자 계정에 ETH가 없어도 됩니다. 페이마스터가 EntryPoint에 미리 deposit한 ETH에서 가스비가 차감됩니다.

```
Owner (EOA)                    PaymasterSigner (EOA)
    │                                │
    ▼                                │
┌──────────────────────────────────────────────┐
│ 1. UserOperation 구성                         │
│    - sender: 스마트 계정 주소 (counterfactual) │
│    - initCode: 최초 배포 시 팩토리 호출        │
│    - callData: account.execute() 인코딩       │
│    - paymasterAndData: 더미 서명으로 초기 구성  │
└──────────────────────────────────────────────┘
    │                                │
    ▼                                ▼
┌──────────────────────────────────────────────┐
│ 2. 서명 (2개, 순서 중요!)                      │
│                                               │
│  ① Paymaster 서명 (먼저)                      │
│     pmHash = paymaster.getHash(userOp, ...)   │
│     pmSig = paymasterSigner.sign(pmHash)      │
│     → paymasterAndData에 서명 삽입             │
│                                               │
│  ② Owner 서명 (나중에)                         │
│     opHash = entryPoint.getUserOpHash(userOp) │
│     signature = owner.sign(opHash)            │
│     → paymasterAndData 포함된 최종 해시에 서명  │
└──────────────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────────┐
│ 3. EntryPoint.handleOps()                     │
│                                               │
│  ┌─ 검증 (2단계) ─────────────────────────┐   │
│  │ account.validateUserOp()               │   │
│  │  └─ owner 서명 검증                     │   │
│  │ paymaster.validatePaymasterUserOp()    │   │
│  │  └─ paymaster 서명 검증                 │   │
│  └────────────────────────────────────────┘   │
│              │                                │
│              ▼                                │
│  ┌─ 배포 (initCode 있을 때만) ────────────┐   │
│  │ factory.createAccount(owner, salt)     │   │
│  │  └─ CREATE2로 스마트 계정 배포          │   │
│  └────────────────────────────────────────┘   │
│              │                                │
│              ▼                                │
│  ┌─ 실행 ─────────────────────────────────┐   │
│  │ account.execute(dest, value, data)     │   │
│  │  └─ 실제 트랜잭션 수행                  │   │
│  └────────────────────────────────────────┘   │
│              │                                │
│              ▼                                │
│  ┌─ 가스 정산 ────────────────────────────┐   │
│  │ 페이마스터의 deposit에서 가스비 차감 ✅  │   │
│  └────────────────────────────────────────┘   │
│              │                                │
│              ▼                                │
│  ┌─ 후처리 (선택) ────────────────────────┐   │
│  │ paymaster.postOp()                     │   │
│  │  └─ ERC-20 토큰 수금 등 후처리 로직     │   │
│  └────────────────────────────────────────┘   │
└──────────────────────────────────────────────┘
```

### 컨트랙트 호출 비교표

| 단계 | 페이마스터 없음 | 페이마스터 있음 |
|------|----------------|----------------|
| **서명 수** | Owner 1개 | Paymaster + Owner 2개 |
| **검증** | `account.validateUserOp()` | `account.validateUserOp()` + `paymaster.validatePaymasterUserOp()` |
| **실행** | `account.execute()` | `account.execute()` (동일) |
| **가스 지불** | 스마트 계정 deposit | 페이마스터 deposit |
| **후처리** | 없음 | `paymaster.postOp()` (선택) |

### 번들러 경유 플로우

위 두 플로우 모두 번들러를 통해 제출할 수 있습니다. 번들러는 UserOp을 수집하여 EntryPoint에 중계하는 역할입니다.

```
Client                    Bundler (port 4337)              EntryPoint (on-chain)
  │                            │                                │
  │  eth_sendUserOperation     │                                │
  │ ─────────────────────────► │                                │
  │                            │  mempool에 저장                │
  │                            │  tryBuild() 실행               │
  │                            │                                │
  │                            │  handleOps([userOps], beneficiary)
  │                            │ ─────────────────────────────► │
  │                            │                                │  검증 → 배포 → 실행 → 정산
  │                            │                                │
  │                            │  UserOperationEvent 로그 파싱  │
  │  ◄─────────────────────── │  ◄───────────────────────────── │
  │  userOpHash 반환           │                                │
```

### 서명 순서가 중요한 이유

```
Owner의 서명 = sign(hash(userOp 전체))
                          ↑
                paymasterAndData 포함!
```

Owner의 서명이 `paymasterAndData`(페이마스터 서명 포함)를 커버하기 때문에, **페이마스터가 먼저 서명**해야 합니다. 이렇게 해야 중간에 누군가 페이마스터 정보를 변조할 수 없습니다.

이 프로젝트의 `scripts/run-full-flow.ts`에서 전체 서명 순서를 확인할 수 있습니다:

```
① factory.getAddress(owner, salt)      → 계정 주소 미리 계산 (CREATE2)
② buildInitCode(factory, owner, salt)  → initCode 생성
③ encodeExecute(to, value, "0x")       → callData 생성
④ paymaster.getHash(userOp, ...)       → 페이마스터 해시 계산
⑤ paymasterSigner.sign(pmHash)         → 페이마스터 서명 (1차)
⑥ entryPoint.getUserOpHash(userOp)     → UserOp 해시 계산
⑦ owner.sign(opHash)                   → 오너 서명 (2차)
⑧ entryPoint.handleOps([userOp], ...)  → 실행
```

## PackedUserOperation (v0.7)

ERC-4337 v0.7은 가스 필드를 `bytes32`로 패킹합니다:

| 필드 | 구조 |
|---|---|
| `accountGasLimits` | `verificationGasLimit` (상위 128bit) + `callGasLimit` (하위 128bit) |
| `gasFees` | `maxPriorityFeePerGas` (상위 128bit) + `maxFeePerGas` (하위 128bit) |
| `paymasterAndData` | `address` (20B) + `validationGas` (16B) + `postOpGas` (16B) + `paymaster-specific data` |

## 기술 스택

- Solidity 0.8.28 (Cancun EVM)
- Hardhat
- ethers.js v6
- @account-abstraction/contracts v0.7
- Express (번들러 서버)
- TypeScript
