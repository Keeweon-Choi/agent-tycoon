# Requirements Document

## Introduction

Members sign in with an email and a password.

## Requirements

### Requirement 1

**User Story:** As a returning member, I want to sign in with my email and password, so that I can see my loans.

#### Acceptance Criteria

1. WHEN a member submits valid credentials THEN the system SHALL create a session
2. WHEN a member submits a wrong password five times THEN the system SHALL lock the account for 15 minutes
3. WHEN a session expires AND the member makes a request THEN the system SHALL answer 401

### Requirement 2: Reset the password

**User Story:** As a member, I want to reset my password by email, so that I can get back in.

#### Acceptance Criteria

1. WHEN a member asks for a reset THEN the system SHALL send a link valid for one hour
2. IF the link is older than one hour THEN the system SHALL refuse it

### Requirement 3

**User Story:** As a librarian, I want to see failed sign-ins, so that I can spot attacks.

#### Acceptance Criteria

1. WHEN five sign-ins fail THEN the system SHALL list the attempt for the librarian
