import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const source = resolve(process.argv[2] ?? "..\\MabiCommerceNewLife\\Data\\commerce-catalog.json");
const catalog = JSON.parse(await readFile(source, "utf8"));
const products = [
	...catalog.products.map(({ id, postId, name, commerceParty }) => ({
		id, postId, name, mode: commerceParty ? "group" : "trade",
	})),
	...catalog.barterProducts.map(({ id, postId, name }) => ({
		id, postId, name, mode: "barter",
	})),
];
const result = {
	version: 1,
	posts: catalog.posts.map(({ id, name, canSell }) => ({ id, name, canSell })),
	products,
};
await writeFile(new URL("../src/catalog.json", import.meta.url), `${JSON.stringify(result, null, "\t")}\n`);
console.log(`Imported ${products.length} goods and ${result.posts.length} posts.`);
