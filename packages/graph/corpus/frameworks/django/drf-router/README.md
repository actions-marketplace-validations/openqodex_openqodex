# Django REST framework: router registrations

Guards against losing API routes declared through a router: `router.register` under a DefaultRouter, included at `api/`, makes list and detail registrations bound to the viewset with its actions as possible handlers. A `register` call on the admin site is not a route, and a computed prefix is a gap.
