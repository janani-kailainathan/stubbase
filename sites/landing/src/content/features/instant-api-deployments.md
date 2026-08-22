---
title: 'Instant API Deployments and State Management — Stubbase'
description: 'Move from draft to production with zero downtime. Manage your API state seamlessly with instant rollbacks and global edge availability.'
h1: 'Instant API Deployments and State Management'
subheadline: 'Move from draft to production with zero downtime. Manage your API state seamlessly with instant rollbacks and global edge availability.'
---

## The Virtual Deployment Engine

Traditional backend deployments require build steps, containerization, and downtime. Stubbase utilizes a virtualized deployment engine that instantly swaps your API state.

- **Draft Environments:** Edits made via UI, AI, or JSON upload are saved in isolation. You can preview endpoint responses in the dashboard without affecting live traffic.
- **Zero-Downtime Swaps:** Clicking "Deploy" flushes the active schema and instantly maps your new draft to the production URL. Client connections remain uninterrupted.
- **Virtual Start / Stop:** Toggle your project's availability instantly. Clicking "Stop" intercepts incoming Edge traffic and returns a clean `503 Service Unavailable`, allowing you to freeze data mutation during frontend maintenance.
