# Feature Specification: 반납 알림

**Feature Branch**: `003-reminders`
**Created**: 2026-11-01
**Status**: Draft

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 반납일 전날 알림 (Priority: P1)

회원이 반납일 하루 전에 문자를 받는다.

**Acceptance Scenarios**:

1. **Given** 내일이 반납일인 대여, **When** 오전 9시가 되면, **Then** 문자가 한 번 간다.

### User Story 2 - 연체 알림 (Priority: P2)

연체된 회원이 사흘마다 알림을 받는다.

**Acceptance Scenarios**:

1. **Given** 연체 3일, **When** 오전 9시가 되면, **Then** 연체 알림이 간다.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST 반납일 전날 오전 9시에 문자를 보낸다.
- **FR-002**: System MUST 같은 대여에 같은 알림을 두 번 보내지 않는다.
- **FR-003**: System MUST 문자 실패를 기록하고 한 번 다시 보낸다.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 알림의 99%가 9시 10분 전에 나간다.
