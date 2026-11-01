// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/**
 * Given names and the short forms they go by, for People's review to see
 * "Jeff Moore" and "Jeffrey Moore" as a similar name (suggest.ts,
 * peopleReview). English names only, and only the common forms: a weaker
 * reason than the same name, said as such, and "Not the same" answers a
 * wrong one. Each line is one family of names; a name in two families (Chris)
 * is in both.
 */

const FAMILIES = [
  "abigail abby abbie gail",
  "abraham abe",
  "albert al bert bertie",
  "alexander alex alec sandy xander",
  "alexandra alex alexa lexi sandra sandy",
  "alfred al alf fred freddie",
  "allison alison allie ali",
  "andrew andy drew",
  "angela angie",
  "anthony tony",
  "barbara barb barbie babs",
  "benjamin ben benji benny",
  "bernard bernie",
  "beverly bev",
  "bradley brad",
  "catherine cathryn katherine kathryn kate katie kathy cathy kat kitty",
  "charles charlie chuck chas",
  "charlotte charlie lottie",
  "christina christine chris tina chrissy",
  "christopher chris kit topher",
  "cynthia cindy",
  "daniel dan danny",
  "david dave davey",
  "deborah debra deb debbie",
  "donald don donnie",
  "dorothy dot dottie",
  "douglas doug",
  "edward ed eddie ted ned",
  "elizabeth liz lizzie beth betsy betty eliza libby",
  "eleanor ellie nora nell",
  "emily em emmy",
  "eugene gene",
  "frances fran frannie",
  "francis frank frankie",
  "frederick fred freddie",
  "gabriel gabe",
  "gabrielle gabby gaby",
  "gerald gerry jerry",
  "gregory greg",
  "harold hal harry",
  "henry hank harry hal",
  "jacob jake",
  "james jim jimmy jamie",
  "janet jan",
  "jeffrey jeff geoffrey geoff",
  "jennifer jen jenny jenn",
  "jessica jess jessie",
  "jonathan jon jonny",
  "john jack johnny",
  "joseph joe joey",
  "joshua josh",
  "judith judy",
  "katherine kate katie kathy kat",
  "kenneth ken kenny",
  "kimberly kim",
  "lawrence laurence larry",
  "leonard leo len lenny",
  "lillian lily lil",
  "margaret maggie meg peggy marge margie greta",
  "matthew matt",
  "megan meg",
  "melissa mel missy",
  "michael mike mikey mick",
  "michelle shelly",
  "nathan nate",
  "nathaniel nate nat",
  "nicholas nick nicky",
  "nicole nikki nicky",
  "pamela pam",
  "patricia pat patty trish tricia",
  "patrick pat paddy",
  "peter pete",
  "philip phillip phil",
  "rebecca becky becca",
  "richard rich rick ricky dick",
  "robert rob bob bobby robbie bert",
  "ronald ron ronnie",
  "samantha sam sammy",
  "samuel sam sammy",
  "stephanie steph",
  "stephen steven steve",
  "susan sue susie suzy",
  "theodore ted teddy theo",
  "thomas tom tommy",
  "timothy tim timmy",
  "victoria vicky tori",
  "vincent vince vinny",
  "walter walt wally",
  "william will bill billy willy liam",
  "zachary zach zack",
];

const familiesOf = new Map<string, number[]>();
FAMILIES.forEach((line, i) => {
  for (const name of line.split(" ")) familiesOf.set(name, [...(familiesOf.get(name) ?? []), i]);
});

/** The families a given name is in (empty for one not known), by number. */
export function nameFamilies(first: string): number[] {
  return familiesOf.get(first.toLowerCase()) ?? [];
}
