# Deployment Guide — OpenClaw AWA Worker Service

> **Version:** 1.0.0  
> **Status:** DRAFT  
> **Target Platform:** Google Cloud Run  

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        CI/CD Pipeline                               │
│                                                                     │
│  GitHub ──> Cloud Build ──> Artifact Registry ──> Cloud Run        │
│   push        trigger          store image        deploy service    │
│                                                                     │
│  + Cloud Storage (Skills Bucket) — deployed separately              │
│  + VPC Connector + Cloud NAT — for egress via proxy                │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 2. Prerequisites

### 2.1 Google Cloud Resources

| Resource | Name Example | Purpose |
|---|---|---|
| Google Cloud Project | `openclaw-prod` | Project hosting all resources |
| Cloud Run Service | `awa-worker` | Serverless container host |
| Artifact Registry | `us-central1-docker.pkg.dev/openclaw-prod/awa-worker` | Container image storage |
| Cloud Storage Bucket | `awa-skills-prod` | Merchant skill script storage |
| VPC Connector | `awa-vpc-connector` | Serverless VPC access for egress |
| Cloud NAT | `awa-nat` | NAT gateway for proxy egress |
| Service Account | `awa-worker-sa@openclaw-prod.iam.gserviceaccount.com` | Worker runtime identity |

### 2.2 Required Permissions

The deployment identity (CI/CD service account or developer) needs:

- `run.services.create` / `run.services.update`
- `run.services.setIamPolicy`
- `artifactregistry.repositories.uploadArtifacts`
- `storage.buckets.update` (for skill bucket)

---

## 3. Building the Container

### 3.1 Local Build

```bash
docker build -t us-central1-docker.pkg.dev/openclaw-prod/awa-worker/worker:latest .
```

### 3.2 Cloud Build

```yaml
# cloudbuild.yaml
steps:
  - name: 'gcr.io/cloud-builders/docker'
    args:
      - 'build'
      - '-t'
      - 'us-central1-docker.pkg.dev/$PROJECT_ID/awa-worker/worker:$SHORT_SHA'
      - '-t'
      - 'us-central1-docker.pkg.dev/$PROJECT_ID/awa-worker/worker:latest'
      - '.'
  - name: 'gcr.io/cloud-builders/docker'
    args:
      - 'push'
      - 'us-central1-docker.pkg.dev/$PROJECT_ID/awa-worker/worker:$SHORT_SHA'

images:
  - 'us-central1-docker.pkg.dev/$PROJECT_ID/awa-worker/worker:$SHORT_SHA'
  - 'us-central1-docker.pkg.dev/$PROJECT_ID/awa-worker/worker:latest'
```

### 3.3 Trigger Configuration

| Event | Branch | Action |
|---|---|---|
| Push to `main` | `main` | Build + Deploy to `prod` |
| Push to `develop` | `develop` | Build + Deploy to `staging` |
| PR to `main` | Any | Build only (no deploy) |
| Tag `v*` | Any | Build + Deploy to `prod` with tag |

---

## 4. Deploying to Cloud Run

### 4.1 Service Definition

```bash
gcloud run deploy awa-worker \
  --image=us-central1-docker.pkg.dev/openclaw-prod/awa-worker/worker:latest \
  --platform=managed \
  --region=us-central1 \
  --memory=2Gi \
  --cpu=2 \
  --concurrency=40 \
  --timeout=60 \
  --max-instances=20 \
  --min-instances=2 \
  --service-account=awa-worker-sa@openclaw-prod.iam.gserviceaccount.com \
  --vpc-connector=awa-vpc-connector \
  --egress=all-traffic \
  --set-env-vars="\
    NODE_ENV=production,\
    GCS_BUCKET=awa-skills-prod,\
    ISOLATE_MEMORY_LIMIT_MB=128,\
    ISOLATE_TIMEOUT_MS=30000,\
    ISOLATE_POOL_SIZE=20,\
    BROWSER_POOL_SIZE=40,\
    LOG_LEVEL=info\
  " \
  --set-secrets="\
    PROXY_API_KEY=proxy-api-key:latest\
  "
```

### 4.2 Key Cloud Run Parameters

| Parameter | Value | Rationale |
|---|---|---|
| `--memory` | `2Gi` | Chromium + 40 isolates needs ~1.5Gi; 2Gi gives headroom |
| `--cpu` | `2` | Concurrent browser rendering benefits from multi-core |
| `--concurrency` | `40` | Matches max concurrent sessions per instance |
| `--timeout` | `60s` | 30s script timeout + 30s buffer for overhead |
| `--max-instances` | `20` | Cost control ceiling |
| `--min-instances` | `2` | Avoid cold start latency for baseline traffic |
| `--vpc-connector` | `awa-vpc-connector` | Route egress through VPC → NAT → proxy |

### 4.3 Using Cloud Run YAML (Declarative)

```yaml
# service.yaml
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: awa-worker
  namespace: openclaw-prod
spec:
  template:
    metadata:
      annotations:
        autoscaling.knative.dev/maxScale: '20'
        autoscaling.knative.dev/minScale: '2'
        run.googleapis.com/vpc-access-egress: all-traffic
        run.googleapis.com/vpc-access-connector: awa-vpc-connector
    spec:
      containerConcurrency: 40
      timeoutSeconds: 60
      serviceAccountName: awa-worker-sa@openclaw-prod.iam.gserviceaccount.com
      containers:
        - image: us-central1-docker.pkg.dev/openclaw-prod/awa-worker/worker:latest
          resources:
            limits:
              memory: 2Gi
              cpu: '2'
          env:
            - name: NODE_ENV
              value: production
            - name: GCS_BUCKET
              value: awa-skills-prod
            - name: ISOLATE_MEMORY_LIMIT_MB
              value: '128'
            - name: ISOLATE_TIMEOUT_MS
              value: '30000'
            - name: ISOLATE_POOL_SIZE
              value: '20'
            - name: BROWSER_POOL_SIZE
              value: '40'
            - name: LOG_LEVEL
              value: info
          secretEnv:
            - name: PROXY_API_KEY
              secretKeyRef:
                name: proxy-api-key
                key: latest
```

Deploy with:

```bash
gcloud run services replace service.yaml --region=us-central1
```

---

## 5. Cloud Storage (Skills Bucket)

### 5.1 Bucket Creation

```bash
gcloud storage buckets create gs://awa-skills-prod \
  --location=us-central1 \
  --uniform-bucket-level-access
```

### 5.2 IAM Permissions

```bash
# Grant the worker service account read access
gcloud storage buckets add-iam-policy-binding gs://awa-skills-prod \
  --member=serviceAccount:awa-worker-sa@openclaw-prod.iam.gserviceaccount.com \
  --role=roles/storage.objectViewer
```

### 5.3 Script Upload

Skills are stored in a directory structure under `user-scripts/<domain>/`:

```
gs://awa-skills-prod/user-scripts/bestbuy.com/
├── manifest.json       # Domain, capabilities, URL patterns
└── skill.js            # Handler implementations
```

```bash
# Upload a merchant skill (two files)
gcloud storage cp manifest.json gs://awa-skills-prod/user-scripts/bestbuy.com/manifest.json
gcloud storage cp skill.js gs://awa-skills-prod/user-scripts/bestbuy.com/skill.js

# Or use the mpx-awa CLI (recommended for local dev)
npm install -g ./mpx-awa
mpx-awa init bestbuy.com       # Scaffold
mpx-awa seed bestbuy.com       # Upload to GCS
```

---

## 6. Secrets Management

| Secret Name | Source | Used By |
|---|---|---|
| `proxy-api-key` | Secret Manager | Worker → Proxy provider auth |
| `cloud-run-invoker-key` | Secret Manager | Brain → Worker auth |

Create secrets:

```bash
echo -n "your-proxy-api-key" | \
  gcloud secrets create proxy-api-key --data-file=-

echo -n "your-service-account-key" | \
  gcloud secrets create cloud-run-invoker-key --data-file=-
```

---

## 7. Networking Setup

### 7.1 VPC Connector

```bash
gcloud compute networks vpc-access connectors create awa-vpc-connector \
  --region=us-central1 \
  --network=default \
  --range=10.8.0.0/28 \
  --min-instances=2 \
  --max-instances=10
```

### 7.2 Cloud NAT

```bash
gcloud compute routers create awa-router \
  --network=default \
  --region=us-central1

gcloud compute routers nats create awa-nat \
  --router=awa-router \
  --region=us-central1 \
  --nat-external-ip-pool=awa-nat-ip \
  --min-ports-per-vm=64
```

---

## 8. CI/CD Pipeline

### 8.1 GitHub Actions

```yaml
# .github/workflows/deploy.yml
name: Deploy AWA Worker

on:
  push:
    branches: [main]
    paths:
      - 'src/**'
      - 'Dockerfile'
      - 'package*.json'
  workflow_dispatch:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npm run lint
      - run: npm run test:unit

  deploy:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - id: auth
        uses: google-github-actions/auth@v2
        with:
          credentials_json: ${{ secrets.GCP_SA_KEY }}

      - uses: google-github-actions/setup-gcloud@v2

      - name: Build and push Docker image
        run: |
          gcloud builds submit \
            --tag us-central1-docker.pkg.dev/${{ vars.GCP_PROJECT }}/awa-worker/worker:${{ github.sha }}

      - name: Deploy to Cloud Run
        run: |
          gcloud run deploy awa-worker \
            --image=us-central1-docker.pkg.dev/${{ vars.GCP_PROJECT }}/awa-worker/worker:${{ github.sha }} \
            --region=us-central1 \
            --platform=managed
```

---

## 9. Environments

| Environment | Cloud Run Service | GCS Bucket | Min Instances | Max Instances | Concurrency |
|---|---|---|---|---|---|
| `dev` | `awa-worker-dev` | `awa-skills-dev` | 1 | 5 | 20 |
| `staging` | `awa-worker-staging` | `awa-skills-staging` | 1 | 10 | 30 |
| `prod` | `awa-worker` | `awa-skills-prod` | 2 | 20 | 40 |

---

## 10. Monitoring & Alerting

### 10.1 Essential Metrics

| Metric | Source | Alert Threshold |
|---|---|---|
| Request latency (p95) | Cloud Run | > 15s |
| Error rate (5xx) | Cloud Run | > 1% |
| Active sessions per instance | Custom metric | > 35 |
| Isolate OOM count | Custom metric | > 0 in 5 minutes |
| Script timeout rate | Custom metric | > 10% |
| Chromium crash count | Custom metric | > 0 in 5 minutes |

### 10.2 Logs-Based Metrics

```bash
# Example: Count isolate OOM events
gcloud logging metrics create isolate-oom-count \
  --description="Number of isolate out-of-memory events" \
  --filter='jsonPayload.errorDetails="Execution memory threshold exceeded."'
```

### 10.3 Recommended Dashboards

- **Request Volume & Latency:** P50/P95/P99 response times, request count by status
- **Session Health:** Active sessions, success/failure/out-of-stock ratio
- **Resource Usage:** CPU, memory per instance, container startup latency
- **Proxy Health:** Egress success rate, IP rotation frequency, proxy latency

---

## 11. Rollback Procedure

```bash
# Rollback to a previous revision
gcloud run revisions list --service=awa-worker --region=us-central1

# Point traffic to a specific revision
gcloud run services update-traffic awa-worker \
  --to-revisions=awa-worker-00005=100 \
  --region=us-central1

# Gradual rollback (10% traffic to old revision)
gcloud run services update-traffic awa-worker \
  --to-revisions=awa-worker-00005=10 \
  --region=us-central1
```

---

## 12. Cost Estimates (Production)

| Resource | Estimated Monthly Cost |
|---|---|
| Cloud Run (2 min + burst to 20, 2Gi each) | ~$300–$600 |
| Cloud NAT + VPC Connector | ~$75 |
| Cloud Storage (Skills Bucket) | ~$5 |
| Secret Manager | ~$5 |
| Residential Proxy Provider | ~$200–$500 |
| **Total Estimated** | **~$585–$1,185** |

---

## 13. Pre-Deployment Checklist

- [ ] Docker image builds and runs locally
- [ ] All unit and integration tests pass
- [ ] `.env.production` contains correct values (no secrets hardcoded)
- [ ] Secrets exist in Secret Manager
- [ ] VPC connector and Cloud NAT are provisioned
- [ ] Skills bucket exists with correct IAM bindings
- [ ] Cloud Run service account has `storage.objectViewer` on bucket
- [ ] Proxy provider credentials are valid
- [ ] `gcloud run deploy` dry-run succeeds
- [ ] Health check endpoint returns `healthy`
- [ ] Monitoring alerts are configured
