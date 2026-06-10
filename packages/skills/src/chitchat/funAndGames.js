// Dice/Coin — port of chitchat-skill/src/utils/FunAndGamesUtils.ts. Instances go
// into PromptData so MIM prompt templates/conditions can read `dice.a`, `dice.b`,
// `coin.a` (flip-a-coin / roll-the-dice responses).

export class Dice {
  constructor(sides = 6, rng = Math.random) {
    this.a = Math.floor(rng() * sides) + 1;
    this.b = Math.floor(rng() * sides) + 1;
  }
}

export class Coin {
  constructor(rng = Math.random) {
    this.a = Math.round(rng()) ? 'heads' : 'tails';
  }
}
