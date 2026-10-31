import commonjs from '@rollup/plugin-commonjs'
import nodeResolve from '@rollup/plugin-node-resolve'
import terser from '@rollup/plugin-terser'
import typescript from '@rollup/plugin-typescript'

const watching = Boolean(process.env.ROLLUP_WATCH)

export default {
  input: 'src/plugin.ts',
  output: {
    file: 'com.nplaudio.lightsfanaction.sdPlugin/bin/plugin.js',
    format: 'es',
    sourcemap: watching,
  },
  plugins: [
    typescript({ tsconfig: './tsconfig.json', compilerOptions: { outDir: undefined, declaration: false } }),
    nodeResolve({ browser: false, exportConditions: ['node'], preferBuiltins: true }),
    commonjs(),
    !watching && terser(),
  ].filter(Boolean),
}
