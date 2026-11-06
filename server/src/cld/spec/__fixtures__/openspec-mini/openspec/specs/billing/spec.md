# Billing Specification

## Purpose

Invoices.

## Requirements

### Requirement: Monthly Invoice

The system SHALL create an invoice on the first day of each month.

#### Scenario: First of the month

- **WHEN** the date is the first of a month
- **THEN** an invoice is created for every active account
