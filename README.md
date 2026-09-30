# Okoa Jamii

## Offline-First Emergency Response and Community Protection Platform

Okoa Jamii is an offline-first emergency response and community protection platform designed to help communities report emergencies quickly and support coordinated response, particularly in areas affected by poor network connectivity and limited access to emergency services.

## Core Features

- Rapid SOS emergency alerts
- Emergency incident reporting
- GPS location capture
- Offline-first operation
- Offline incident queueing
- Automatic synchronization when connectivity returns
- SMS fallback architecture
- Emergency contacts
- Community alerts
- Real-time incident monitoring
- Response coordination
- Incident escalation
- Analytics and reporting
- Role-based access control
- Audit logging

## Technology Stack

### Mobile Application

- React Native
- Expo
- Expo Router
- TypeScript
- Zustand

### Administration Dashboard

- Next.js
- TypeScript
- Tailwind CSS
- Leaflet
- Recharts

### Backend

- Node.js
- Express
- TypeScript
- MongoDB Atlas
- Mongoose
- Socket.IO

### Security

- JWT authentication
- Refresh tokens
- bcrypt
- Helmet
- Rate limiting
- Role-based access control

## Project Structure

```text
OKOA-JAMII/
├── mobile/
├── dashboard/
├── backend/
├── docs/
├── .gitignore
├── README.md
└── package.json
```

## Development Team

Okoa Jamii is being developed by a five-member development team.

| Developer | Responsibility |
|---|---|
| Developer 1 | Technical Lead / Project Architect |
| Developer 2 | Mobile Authentication & User Experience |
| Developer 3 | Mobile Emergency & Incident Management |
| Developer 4 | Admin Dashboard |
| Developer 5 | Response, Analytics & Administration |

## Development Branches

```text
main
├── feature/project-foundation
├── feature/mobile-auth
├── feature/mobile-emergency
├── feature/admin-dashboard
└── feature/admin-operations
```

## Development Workflow

All feature development must take place on feature branches.

```text
Feature Branch
      ↓
Development
      ↓
Testing
      ↓
Commit
      ↓
Push
      ↓
Pull Request
      ↓
Technical Lead Review
      ↓
Merge
      ↓
main
```

Direct development on `main` is not permitted.

## Development Principles

The project follows these principles:

- Offline-first design
- Clean architecture
- Reusable components
- Strict TypeScript
- Secure development practices
- Accessible user interfaces
- Responsive design
- Low-end device awareness
- Clear separation between frontend and backend
- Mock services during frontend development
- Incremental development
- Code review before merging

## Current Development Phase

The project is currently in the **frontend architecture and development phase**.

The backend, database, real-time services, authentication infrastructure, notification infrastructure and production integrations will be implemented in later phases.

## Repository

The GitHub repository contains the complete project source code, documentation and development history.

## License

This project is currently being developed as a university software development project.