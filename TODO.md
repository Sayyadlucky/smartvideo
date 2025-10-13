# PIP Floating Window Implementation Plan

## Tasks to Complete

### 1. Update dashboard.ts
- [ ] Change `shouldShowSelfVideo` to `return this.you?.videoOn ?? false;`
- [ ] Remove `fullParticipant` and `featuredParticipants` getters
- [ ] Add `get layoutCount(): number { return this.participants.length; }`
- [ ] Refactor `get gridParticipants()` to:
  - Always include remotes
  - Include self only if `!this.you?.videoOn`, else include placeholder copy
  - Order for single remote video in layout-3 (video last for span-full)

### 2. Update dashboard.html
- [ ] Remove `<div *ngIf="fullParticipant" class="full-video-container ...">` block
- [ ] Change tile-grid `[ngClass]` to use `layoutCount` instead of `gridParticipants.length`
- [ ] Update video `*ngIf` to `*ngIf="p.stream && p.videoOn"`
- [ ] Update placeholder `*ngIf` to `*ngIf="!p.videoOn || !p.stream"`

### 3. Update dashboard.scss
- [ ] Add `.tile-placeholder { opacity: 0.7; }` for self placeholder when cam on

### 4. Testing and Verification
- [ ] Run `ng serve` in `conference/frontend/` to start dev server
- [ ] Test scenarios: alone, 2 participants, 3 participants, multiple videos, join/leave
- [ ] Verify PIP always shows when self cam on, layouts match WhatsApp behavior
- [ ] Use browser_action to demo if needed
