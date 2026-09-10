# jiborobot/srv-robots-ws:src/aggregates/abstract.aggregate.js@4c8b1b75f3e0ccb90fab160019637704ba62d36a


export default class AbstractAggregate {
  constructor(id) {
    this.id = id;
    this.events = {};
  }
  applyEvent(event) {
    if (!this.events[event.name]) {
      throw new Error('Unknown event: ' + event.name);
    }
    this.events[event.name].call(this, event);
  }
  toJs() {
    return this;
  }
  toJson() {
    return JSON.stringify(this.toJs());
  }
}
