# Feature Specification: Loan renewal

**Feature Branch**: `004-loan-renewal`
**Status**: Draft

## User Scenarios & Testing

### User Story 1 - Renew a loan once (Priority: P1)

A member renews a book they still have, once, before it is due.

**Acceptance Scenarios**:

1. **Given** a loan due in 3 days, **When** the member renews it, **Then** the due date moves 14 days later.
2. **Given** a loan already renewed once, **When** the member renews it, **Then** the renewal is refused with the reason.

### User Story 2 - See when a renewal is refused (Priority: P2)

The member sees why a renewal was refused.

**Acceptance Scenarios**:

1. **Given** a reserved book, **When** the member renews it, **Then** the page says another member is waiting.

## Requirements

### Functional Requirements

- **FR-001**: The system MUST let a member renew a loan before its due date.
- **FR-002**: The system MUST allow one renewal per loan.
- **FR-003**: The system MUST refuse a renewal when another member reserved the book, and say so.
- **FR-004**: The system MUST keep the renewal limit per library at [NEEDS CLARIFICATION: one limit for every library, or one each?]

## Success Criteria

- **SC-001**: A member renews a loan in under 30 seconds.
