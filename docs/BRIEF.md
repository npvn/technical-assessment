# Brief: The Unified Service Scheduler

Domain: Ownership

Task: build an appointment scheduler to replace manual booking systems.

## Core requirements

1. **Resource constrained booking.** A user requests a service appointment for a specific vehicle, service type and dealership at a desired time.
2. **Real-time availability check.** Before confirming, check that both a `ServiceBay` and a qualified `Technician` are available for the entire service duration.
3. **Confirmed appointment record.** On success, create a persistent `Appointment` record that links the customer, vehicle, technician and service bay.

## Deliverables

1. A system design document: architecture diagram, the role of each component, data flow, technology choices with reasons, observability strategy, and how AI agents helped in the design phase.
2. Working code for one layer (this repo implements the backend): a RESTful API on a persistent database, with the client side stubbed (OpenAPI spec and cURL examples). A README with build, run and test instructions and an AI collaboration narrative. Tests that validate the core business logic.
3. A 5 to 10 minute talk.

Build for the future: consider scalability, performance, reliability, maintainability and observability.

Requirements may be ambiguous on purpose. Make reasonable assumptions and write them down in the design document.
