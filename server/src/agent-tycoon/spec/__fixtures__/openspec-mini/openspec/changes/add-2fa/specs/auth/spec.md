## ADDED Requirements

### Requirement: Two-Factor Authentication

The system SHALL require a one-time code after the password when two-factor is on.

#### Scenario: Code required

- **WHEN** a user with two-factor signs in with a valid password
- **THEN** a one-time code is requested

## MODIFIED Requirements

### Requirement: Session Expiry

Sessions SHALL expire after 15 minutes of inactivity (Previously: 30 minutes).

#### Scenario: Idle session

- **WHEN** 15 minutes pass without a request
- **THEN** the session is closed

## REMOVED Requirements

### Requirement: Remember Me

**Reason**: Replaced by two-factor devices.

## RENAMED Requirements

- FROM: `### Requirement: Login`
- TO: `### Requirement: User Authentication`
