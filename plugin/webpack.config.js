const { resolve } = require('path');
const glob = require('glob');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyPlugin = require('copy-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const { ESBuildMinifyPlugin } = require('esbuild-loader');

const isProd = process.env.NODE_ENV === 'production';
const sandboxSuffix = '-sandbox';
const entries = glob.sync('./src/widgets/**/*.tsx').reduce((result, file) => {
  const name = file
    .replace(/^\.\/src\/widgets\//, '')
    .replace(/\.tsx$/, '')
    .replace(/\\/g, '/');
  result[name] = file;
  result[`${name}${sandboxSuffix}`] = file;
  return result;
}, {});

module.exports = {
  mode: isProd ? 'production' : 'development',
  entry: entries,
  output: {
    path: resolve(__dirname, 'dist'),
    filename: '[name].js',
    publicPath: '',
  },
  resolve: {
    extensions: ['.js', '.jsx', '.ts', '.tsx'],
  },
  module: {
    rules: [
      {
        test: /\.(ts|tsx|jsx|js)$/,
        loader: 'esbuild-loader',
        options: {
          loader: 'tsx',
          target: 'es2020',
          minify: false,
        },
      },
      {
        test: /\.css$/i,
        use: [
          isProd ? MiniCssExtractPlugin.loader : 'style-loader',
          { loader: 'css-loader', options: { url: false } },
        ],
      },
    ],
  },
  plugins: [
    isProd ? new MiniCssExtractPlugin({ filename: '[name].css' }) : undefined,
    new HtmlWebpackPlugin({
      templateContent: `
        <body></body>
        <script type="text/javascript">
          const params = new URLSearchParams(window.location.search);
          const widgetName = params.get('widgetName');
          if (!widgetName) document.body.innerHTML = 'Widget ID not specified.';
          if (widgetName) {
            const script = document.createElement('script');
            script.src = widgetName + '${sandboxSuffix}.js';
            document.body.appendChild(script);
          }
        </script>
      `,
      filename: 'index.html',
      inject: false,
    }),
    new CopyPlugin({
      patterns: [
        { from: 'public', to: '' },
        { from: '../README.md', to: 'README.md' },
      ],
    }),
  ].filter(Boolean),
  optimization: isProd
    ? {
        minimize: true,
        minimizer: [new ESBuildMinifyPlugin()],
      }
    : undefined,
  devServer: isProd
    ? undefined
    : {
        port: 8080,
        hot: true,
        compress: true,
        watchFiles: ['src/**/*', 'public/**/*'],
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'baggage, sentry-trace',
        },
      },
};

