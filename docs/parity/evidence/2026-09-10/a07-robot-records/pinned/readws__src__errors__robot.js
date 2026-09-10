# jiborobot/srv-robots-read-ws:src/errors/robot.js@decbbf7e959af3dabe2384940cb316b0689a18b4

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
export const SERIAL_NUMBER_NOT_SET = {
  statusCode: 422,
  message: 'Serial number not set for the robot',
  code: 'SERIAL_NUMBER_NOT_SET'
};
export const SERIAL_NUMBER_NOT_MATCH = {
  statusCode: 422,
  message: 'Provided serial number does not match with stored one',
  code: 'SERIAL_NUMBER_NOT_MATCH'
};
export const ROBOT_NOT_FOUND = {
  statusCode: 404,
  message: 'Robot not found',
  code: 'ROBOT_NOT_FOUND'
};
export const ROBOT_NAMES_NOT_GENERATED = {
  statusCode: 409,
  message: 'Failed to find enough random names in reasonable amount of time',
  code: 'ROBOT_NAMES_NOT_GENERATED'
};
