#!/bin/sh

dir=$(dirname $0)
cd "$dir" || exit 1

echo "\nTEST mocha $i"
mocha mocha/

for i in `ls assert/*.js`; do
  echo "\nTEST node $i"
  node "$i"
done

for i in `ls assert_root/*.js`; do
  echo "\nTEST node root $i"
  node "$i"
done

for i in `ls mocha_root/*.js`; do
  echo "\nTEST mocha root $i"
  mocha "$i"
done
