# Feature Specification: 대여와 반납

**Feature Branch**: `002-checkout`
**Created**: 2026-10-24
**Status**: Draft

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 책 빌리기 (Priority: P1)

회원이 책을 골라 2주 동안 빌린다.

**Acceptance Scenarios**:

1. **Given** 대여 가능한 책, **When** 빌리기를 누르면, **Then** 반납일이 2주 뒤로 정해진다.

### User Story 2 - 반납하기 (Priority: P1)

사서가 반납된 책을 스캔해 대여를 끝낸다.

**Acceptance Scenarios**:

1. **Given** 빌린 책, **When** 바코드를 스캔하면, **Then** 대여가 끝나고 책이 다시 대여 가능이 된다.

### User Story 3 - 연장하기 (Priority: P3)

회원이 반납일을 한 번 1주 늘린다.

**Acceptance Scenarios**:

1. **Given** 연장한 적 없는 대여, **When** 연장을 누르면, **Then** 반납일이 1주 뒤로 간다.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST 회원 한 명당 동시에 5권까지만 빌려준다.
- **FR-002**: System MUST 반납일을 대여일 + 14일로 정한다.
- **FR-003**: System MUST 바코드 스캔으로 반납을 처리한다.
- **FR-004**: System MUST 연장을 대여당 한 번만 허락한다.
- **FR-005**: System MUST 연체 중인 회원에게 새 대여를 막는다.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 반납 스캔부터 대여 가능 표시까지 2초 안.
- **SC-002**: 대여 기록이 하나도 사라지지 않는다.
