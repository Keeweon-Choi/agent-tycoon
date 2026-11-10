# Feature Specification: 책 목록과 검색

**Feature Branch**: `001-catalog`
**Created**: 2026-10-20
**Status**: Draft

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 제목으로 책 찾기 (Priority: P1)

손님이 제목 일부로 책을 찾고 대여 가능 여부를 본다.

**Acceptance Scenarios**:

1. **Given** 책 300권, **When** "고양이"로 찾으면, **Then** 제목에 고양이가 든 책만 1초 안에 보인다.

### User Story 2 - 분류로 둘러보기 (Priority: P2)

손님이 분류(소설, 그림책 등)를 눌러 책을 둘러본다.

**Acceptance Scenarios**:

1. **Given** 분류 8개, **When** 그림책을 누르면, **Then** 그림책만 20권씩 보인다.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST 제목 일부로 책을 찾는다.
- **FR-002**: System MUST 책마다 대여 가능 여부를 보인다.
- **FR-003**: System MUST 분류별 목록을 20권씩 나눠 보인다.
- **FR-004**: System MUST 표지 그림이 없으면 기본 그림을 보인다. [NEEDS CLARIFICATION: 기본 그림 크기]

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 책 300권에서 검색 결과가 1초 안에 나온다.
- **SC-002**: 손님 10명 중 9명이 첫 시도에 원하는 책을 찾는다.
