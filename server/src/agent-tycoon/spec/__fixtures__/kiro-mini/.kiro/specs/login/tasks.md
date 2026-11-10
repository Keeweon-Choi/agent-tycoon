# Implementation Plan

- [x] 1. Set up the auth module
  - Create `AuthService` and `TokenService`
  - _Requirements: 1.1_

- [ ] 2. Implement sign-in
  - [x] 2.1 Verify credentials and create the session
    - _Requirements: 1.1, 1.3_
  - [ ] 2.2 Lock the account after repeated failures
    - _Requirements: 1.2_

- [ ] 3. Implement the password reset
  - [ ]* 3.1 Write unit tests for the reset link
    - _Requirements: 2.1, 2.2_
  - [ ] 3.2 Send the reset mail
    - _Requirements: 2.1_

- [ ] 4. Failed sign-in list
  - Show the attempts to the librarian
  - _Requirements: 3.1_
  - [ ] 4.1 Wire the list into the staff screen
  - _Requirements: 3.1_

- [ ] 5. Hand over
  - _Requirements: R1_
