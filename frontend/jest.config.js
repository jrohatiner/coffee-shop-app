const nextJest = require('next/jest')

const createJestConfig = nextJest({
  dir: './',
})

/** @type {import('jest').Config} */
const customJestConfig = {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/staff-pages.test.tsx'],
  modulePathIgnorePatterns: ['<rootDir>/.next/'],
}

module.exports = createJestConfig(customJestConfig)
