// force timezone to UTC to allow tests to work regardless of local timezone
// generally used by snapshots, but can affect specific tests
process.env.TZ = 'UTC';

const baseConfig = require('./.config/jest.config');

// Use ts-jest instead of @swc/jest — @swc/core native addon SIGBUS on Rosetta x86 Node (macOS 26+).
module.exports = {
  ...baseConfig,
  transform: {
    '^.+\\.(t|j)sx?$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.jest.json',
        isolatedModules: true,
      },
    ],
  },
};
