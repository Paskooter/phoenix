# jiborobot/srv-notification-ws:src/routes/route.ts

import {Boom, Joi, log } from "@jibo/server";

export default class Route {
  constructor(controller, server) {

    server.route({
      config: {
        validate: {
          params: {
            id: Joi.string().required(),
          },
        },
      },
      handler(request, reply) {
        log.debug("Got token request for: ", request.params.id);
        controller.findByToken(request.params.id).then(
          (result) => reply(result),
          (err) => {
            if (err.isBoom) {
              reply(err);
            } else {
              log.error("Unexpected error %j at GET notification-ws/token/{id} request:", err, request);
              reply(Boom.badImplementation(err));
            }
          });
      },
      method: "GET",
      path: "/token/{id}",
    });
    server.route({
      config: {
        validate: {
          params: {
            id: Joi.string().required(),
          },
        },
      },
      handler(request, reply) {
        controller.markAsDelivered(request.params.id).then(
          (result) => reply(result),
          (err) => {
            if (err.isBoom) {
              reply(err);
            } else {
              log.error("Unexpected error %j at DELETE notification-ws/notification/{id} request:", err, request);
              reply(Boom.badImplementation(err));
            }
          });
        },
      method: "DELETE",
      path: "/notification/{id}",
    });
    server.route({
      config: {
        validate: {
          payload: {
            ids: Joi.array().items(Joi.string()),
          },
        },
      },
      handler(request, reply) {
        controller.getNewNotifications(request.payload.ids).then(
          (result) => reply(result),
          (err) => {
            if (err.isBoom) {
              reply(err);
            } else {
              log.error("Unexpected error %j at POST notification-ws/notifications/ request:", err, request);
              reply(Boom.badImplementation(err));
            }
          });
      },
      method: "POST",
      path: "/notifications/",
    });
  }
}
