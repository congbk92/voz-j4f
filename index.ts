import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { experimental_evaluate as evaluate } from 'ai';

const result = await evaluate({
  model: 'typesafe-ai/jev', // This is the Gateway model ID
  state: 'The agent fixed the checkout bug and all tests pass.',
  questions: {
    continueWorking: {
      type: 'boolean',
      instructions: 'Should the agent take another step?',
    },
  },
});

// Access the probability (0 to 1) for the boolean answer
const shouldContinue = result.answers.continueWorking.probability >= 0.8;
console.log(shouldContinue);

// import { generateText } from 'ai';
//
// const { text } = await generateText({
//   model: 'openai/gpt-5.5',
//   prompt: 'Invent a new holiday and describe its traditions.',
// });

// console.log(text);
