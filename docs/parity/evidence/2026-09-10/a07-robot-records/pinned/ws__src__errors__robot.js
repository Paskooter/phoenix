# jiborobot/srv-robots-ws:src/errors/robot.js@4c8b1b75f3e0ccb90fab160019637704ba62d36a

export const ENTITY_ALREADY_EXISTS = {
  statusCode: 409,
  message: 'Entity already exists',
  code: 'ENTITY_ALREADY_EXISTS'
};
export const ENTITY_NOT_FOUND = {
  statusCode: 404,
  message: 'Entity not found',
  code: 'ENTITY_NOT_FOUND'
};
export const ENTITY_DELETED = {
  statusCode: 410,
  message: 'Entity is deleted',
  code: 'ENTITY_DELETED'
};
export const MANUFACTURING_ONLY = {
  statusCode: 403,
  message: 'Only manufacturing account can access this method',
  code: 'MANUFACTURING_ONLY'
};
export const MANUFACTURING_OR_OWNER_ONLY = {
  statusCode: 403,
  message: 'Only manufacturing or owner account can access this method',
  code: 'MANUFACTURING_OR_OWNER_ONLY'
};
export const ROBOT_OR_OWNER_ONLY = {
  statusCode: 403,
  message: 'Only robot or owner account can access this method',
  code: 'ROBOT_OR_OWNER_ONLY'
};
