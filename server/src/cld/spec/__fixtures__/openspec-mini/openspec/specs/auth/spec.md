# Auth Specification

## Purpose

Sign-in for the web app.

## Requirements

### Requirement: User Authentication

The system SHALL issue a JWT token when a user signs in with valid credentials.

#### Scenario: Valid credentials

- **WHEN** the user submits the login form with a valid email and password
- **THEN** a JWT token is returned
- **AND** the user is redirected to the dashboard

#### Scenario: Wrong password

- **WHEN** the user submits a wrong password
- **THEN** an error message is shown

### Requirement: Session Expiry

Sessions SHALL expire after 30 minutes of inactivity.

#### Scenario: Idle session

- **WHEN** 30 minutes pass without a request
- **THEN** the session is closed
